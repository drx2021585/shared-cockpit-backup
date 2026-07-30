using SharedCockpit.Bridge.Bridge;
using Xunit;

namespace SimulatorBridge.Tests;

/// <summary>
/// Tests de la transformación de RPN que invierte la dirección de un control
/// posicional, y de la memoria de lo aprendido.
///
/// Lo crítico acá NO es que la inversión funcione en el caso feliz, sino que NO
/// toque las otras tres formas de RPN del perfil ni los controles ya calibrados
/// a mano: una inversión indebida rompe un control que funcionaba.
/// </summary>
public class PolarityCalibrationTests
{
    /// <summary>
    /// Forma canónica que emite tools/generate_ifly_profile.py para los ~340
    /// selectores posicionales. Es la única que se debe poder invertir.
    /// </summary>
    private const string PositionalRpn =
        "(L:VC_Autobrake_SW_VAL,number) $value < if{ 2 (>L:VC_Gear_trigger_VAL,number) } " +
        "(L:VC_Autobrake_SW_VAL,number) $value > if{ 3 (>L:VC_Gear_trigger_VAL,number) }";

    [Fact]
    public void Invert_SwapsDirection_WithoutTouchingCommandCodes()
    {
        var inverted = PolarityCalibration.Invert(PositionalRpn);

        Assert.NotNull(inverted);

        // La rama que antes disparaba el código 2 al ir hacia ARRIBA ahora lo
        // dispara al ir hacia ABAJO, y viceversa. Los códigos (2 y 3) y la
        // estructura no se tocan.
        Assert.Contains("$value > if{ 2 ", inverted);
        Assert.Contains("$value < if{ 3 ", inverted);

        // Y la inversión es su propia inversa: aplicarla dos veces vuelve al
        // original. Esto es lo que hace segura la reversión ante un fallo genuino.
        Assert.Equal(PositionalRpn, PolarityCalibration.Invert(inverted));
    }

    [Theory]
    // Botón momentáneo: el `0` entre el marcador y el operador lo excluye. Invertir
    // esto cambiaría "pulsar" por "soltar", rompiendo 568 controles.
    [InlineData("$value 0 > if{ 5 (>L:VC_Fuel_trigger_VAL,number) } els{ 6 (>L:VC_Fuel_trigger_VAL,number) }")]
    // Código único: iFly cicla la posición, no hay dirección que invertir (133).
    [InlineData("(L:VC_X_VAL,number) $value != if{ 9 (>L:VC_Fuel_trigger_VAL,number) }")]
    // engine.apu_sw, medido y corregido A MANO en vivo: compara por bandas porque
    // la L-Var se anima. Invertirlo automáticamente desharía esa calibración.
    [InlineData("(L:VC_APU_SW_VAL,number) 5 < $value 5 > and if{ 8 (>L:VC_Engine_APU_trigger_VAL,number) } " +
                "(L:VC_APU_SW_VAL,number) 5 > $value 5 < and if{ 7 (>L:VC_Engine_APU_trigger_VAL,number) }")]
    // Eje continuo: un SET absoluto, sin dirección.
    [InlineData("$value -16384 * -16384 16384 min max (>K:AXIS_ELEVATOR_SET)")]
    public void Invert_RefusesEveryFormThatIsNotAGeneratedPositionalSelector(string rpn)
    {
        Assert.False(PolarityCalibration.CanInvert(rpn));
        Assert.Null(PolarityCalibration.Invert(rpn));
    }

    [Fact]
    public void ShouldTryInverting_IsFalse_OnceAlreadyInvertedOrRuledOut()
    {
        var calibration = new PolarityCalibration();

        Assert.True(calibration.ShouldTryInverting("ifly-737-max8", "gear.autobrake_sw", PositionalRpn));

        calibration.MarkInverted("ifly-737-max8", "gear.autobrake_sw");
        Assert.True(calibration.IsInverted("ifly-737-max8", "gear.autobrake_sw"));

        // Ya se probó esa dirección: no tiene sentido volver a invertirla.
        Assert.False(calibration.ShouldTryInverting("ifly-737-max8", "gear.autobrake_sw", PositionalRpn));

        // Revertir no reabre la puerta: si la inversión no arregló nada, la causa
        // era otra y reintentarla sería un bucle.
        calibration.RevertInversion("ifly-737-max8", "gear.autobrake_sw");
        Assert.False(calibration.IsInverted("ifly-737-max8", "gear.autobrake_sw"));
        Assert.False(calibration.ShouldTryInverting("ifly-737-max8", "gear.autobrake_sw", PositionalRpn));
    }

    [Fact]
    public void Calibration_IsScopedPerProfile_NotGlobalPerControlId()
    {
        var calibration = new PolarityCalibration();
        calibration.MarkInverted("ifly-737-max8", "gear.autobrake_sw");

        // Dos aeronaves distintas pueden tener un control con el MISMO id y
        // polaridades opuestas -- lo aprendido de una no puede contaminar la otra.
        Assert.False(calibration.IsInverted("pmdg-737-900", "gear.autobrake_sw"));
    }

    [Fact]
    public void Calibration_SurvivesRestart_WhenPersisted()
    {
        var path = Path.Combine(Path.GetTempPath(), $"polarity-{Guid.NewGuid():N}.json");
        try
        {
            var first = new PolarityCalibration(path);
            first.MarkInverted("ifly-737-max8", "engine.start_sw_1");

            // Una instancia nueva (= el bridge reabierto) tiene que arrancar ya
            // sabiendo lo que se midió antes. Sin esto, cada sesión pagaría de
            // nuevo el paso perdido de cada control mal calibrado.
            var reopened = new PolarityCalibration(path);
            Assert.True(reopened.IsInverted("ifly-737-max8", "engine.start_sw_1"));
            Assert.False(reopened.IsInverted("ifly-737-max8", "engine.start_sw_2"));
        }
        finally
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
    }

    [Fact]
    public void Calibration_StartsEmpty_WhenPersistedFileIsCorrupt()
    {
        var path = Path.Combine(Path.GetTempPath(), $"polarity-{Guid.NewGuid():N}.json");
        try
        {
            File.WriteAllText(path, "{ esto no es el JSON esperado");

            // Un archivo corrupto degrada a "se re-aprende", nunca impide arrancar
            // el bridge.
            var calibration = new PolarityCalibration(path);
            Assert.Empty(calibration.InvertedKeys);
        }
        finally
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
    }
}
