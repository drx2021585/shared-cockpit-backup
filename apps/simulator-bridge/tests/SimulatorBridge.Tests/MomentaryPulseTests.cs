using SharedCockpit.Bridge.Bridge;
using SharedCockpit.Bridge.Profiles;
using Xunit;

namespace SimulatorBridge.Tests;

/// <summary>
/// El reconocimiento de pulsos decide si un control queda FUERA de dos
/// optimizaciones del bridge (confirmAfterWrite y AlreadyAtValue). Un falso
/// positivo dejaría un selector posicional sin lazo de convergencia y sin el
/// filtro anti-avalancha; un falso negativo devuelve los 568 momentáneos del iFly
/// al comportamiento de pulsar la tecla nueve veces.
/// </summary>
public class MomentaryPulseTests
{
    [Theory]
    // Teclado del CDU/FMS -- forma exacta que emite el generador.
    [InlineData("$value 0 > if{ 11 (>L:VC_Navigation_trigger_VAL,number) } els{ 12 (>L:VC_Navigation_trigger_VAL,number) }")]
    // Variaciones de espaciado que el generador puede producir.
    [InlineData("$value 0> if{ 3 (>L:VC_Fuel_trigger_VAL,number) } els{ 4 (>L:VC_Fuel_trigger_VAL,number) }")]
    [InlineData("$value   0   >   if{ 3 (>L:X,number) }  els{ 4 (>L:X,number) }")]
    public void IsPulse_RecognizesTheGeneratedMomentaryButtonForm(string rpn) =>
        Assert.True(MomentaryPulse.IsPulse(rpn));

    [Fact]
    public void IsPulseControl_RecognizesIflySdkClickEventAsMomentaryPulse()
    {
        var control = new ControlDefinition
        {
            Id = "autoflight.vnav_sw",
            DataType = ControlDataType.Boolean,
            Write = new ControlWriteDefinition
            {
                Type = WriteType.ClientDataEvent,
                AreaName = "iFly737MAX_SDK_Control",
                Event = "KEY_COMMAND_AUTOMATICFLIGHT_VNAV",
                Parameter = "1|0|0",
            },
        };

        Assert.True(MomentaryPulse.IsPulseControl(control));
    }

    [Theory]
    // Selector posicional: compara contra $value, sin rama els{.
    [InlineData("(L:VC_Autobrake_SW_VAL,number) $value < if{ 2 (>L:VC_Gear_trigger_VAL,number) } " +
                "(L:VC_Autobrake_SW_VAL,number) $value > if{ 3 (>L:VC_Gear_trigger_VAL,number) }")]
    // Código único: iFly cicla la posición.
    [InlineData("(L:VC_X_VAL,number) $value != if{ 9 (>L:VC_Fuel_trigger_VAL,number) }")]
    // engine.apu_sw, calibrado a mano por bandas: compara contra 5, no contra 0.
    [InlineData("(L:VC_APU_SW_VAL,number) 5 < $value 5 > and if{ 8 (>L:VC_Engine_APU_trigger_VAL,number) } " +
                "(L:VC_APU_SW_VAL,number) 5 > $value 5 < and if{ 7 (>L:VC_Engine_APU_trigger_VAL,number) }")]
    // Eje continuo: SET absoluto, sin condicional.
    [InlineData("$value -16384 * -16384 16384 min max (>K:AXIS_ELEVATOR_SET)")]
    public void IsPulse_DoesNotMisclassifyAnyOtherWriteForm(string rpn) =>
        Assert.False(MomentaryPulse.IsPulse(rpn));

    /// <summary>
    /// Un pulso y un selector posicional pueden compartir la comparación contra un
    /// número; lo que los separa es la rama `els{`. Sin ella no es un pulso, aunque
    /// compare contra 0.
    /// </summary>
    [Fact]
    public void IsPulse_RequiresTheElseBranch_NotJustAComparisonAgainstZero()
    {
        Assert.False(MomentaryPulse.IsPulse(
            "(L:VC_X_VAL,number) $value 0 > if{ 5 (>L:VC_Fuel_trigger_VAL,number) }"));
    }

    [Fact]
    public void IsPulse_HandlesNullAndEmpty()
    {
        Assert.False(MomentaryPulse.IsPulse(null));
        Assert.False(MomentaryPulse.IsPulse(string.Empty));
    }

    [Fact]
    public void IsPulseControl_DoesNotMisclassifyIflySdkSetEvent()
    {
        var control = new ControlDefinition
        {
            Id = "autoflight.heading_sw",
            DataType = ControlDataType.Number,
            Write = new ControlWriteDefinition
            {
                Type = WriteType.ClientDataEvent,
                AreaName = "iFly737MAX_SDK_Control",
                Event = "KEY_COMMAND_AUTOMATICFLIGHT_HDG_SEL_SET",
                Parameter = "1|$value|0",
            },
        };

        Assert.False(MomentaryPulse.IsPulseControl(control));
    }

    [Fact]
    public void TryParseSinglePress_ExtractsTriggerAndCommandCode()
    {
        var ok = MomentaryPulse.TryParseSinglePress(
            "$value 0 > if{ 83 (>L:VC_Communications_trigger_VAL,number) }",
            out var trigger,
            out var code);

        Assert.True(ok);
        Assert.Equal("L:VC_Communications_trigger_VAL", trigger);
        Assert.Equal(83, code);
    }

    [Fact]
    public void TryParseSinglePress_RejectsTwoBranchPulses()
    {
        var ok = MomentaryPulse.TryParseSinglePress(
            "$value 0 > if{ 11 (>L:VC_Navigation_trigger_VAL,number) } els{ 12 (>L:VC_Navigation_trigger_VAL,number) }",
            out _,
            out _);

        Assert.False(ok);
    }
}
