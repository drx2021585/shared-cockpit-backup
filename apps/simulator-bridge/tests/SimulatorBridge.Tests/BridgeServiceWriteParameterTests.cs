using System.Reflection;
using SharedCockpit.Bridge.Bridge;
using SharedCockpit.Bridge.Profiles;
using Xunit;

namespace SimulatorBridge.Tests;

/// <summary>
/// Cubre BridgeService.ResolveWriteEventParameter (soporte de "parameter
/// dinámico" para write.type: clientDataEvent, ver
/// aircraft-profiles/pmdg-737-900/EVENT_IDS_PENDIENTES.md sección
/// "electrical.dc_meter_selector/...". Antes de este soporte, un
/// clientDataEvent SIEMPRE transmitía Control.Parameter=0 (o el literal
/// estático del perfil), sin importar el valor real que el usuario estaba
/// escribiendo -- este es el bug real reportado para lights.dome_white_sw
/// (selector de 3 posiciones) y, de forma más sutil, para lights.taxi
/// (boolean).
///
/// El método es privado y estático (detalle de implementación de
/// BridgeService, no expuesto en la interfaz pública) -- se invoca vía
/// reflection en vez de hacerlo 'internal'/'public' para no ensanchar la
/// superficie pública del bridge solo por testabilidad.
/// </summary>
public class BridgeServiceWriteParameterTests
{
    private static string? Resolve(string? declaredParameter, ControlDataType dataType, object value)
    {
        var method = typeof(BridgeService).GetMethod(
            "ResolveWriteEventParameter",
            BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(method);

        return (string?)method!.Invoke(null, new object?[] { declaredParameter, dataType, value });
    }

    [Fact]
    public void DynamicPlaceholder_BooleanTrue_ResolvesToOne()
    {
        var result = Resolve("$value", ControlDataType.Boolean, true);

        Assert.Equal("1", result);
    }

    [Fact]
    public void DynamicPlaceholder_BooleanFalse_ResolvesToZero()
    {
        var result = Resolve("$value", ControlDataType.Boolean, false);

        Assert.Equal("0", result);
    }

    [Theory]
    [InlineData(0d, "0")]
    [InlineData(1d, "1")]
    [InlineData(2d, "2")]
    public void DynamicPlaceholder_NumberSelectorPosition_ResolvesToAbsolutePosition(double value, string expected)
    {
        // Ej. lights.dome_white_sw: 0 DIM / 1 OFF / 2 BRIGHT -- el bug real era que
        // el bridge SIEMPRE transmitía 0 (DIM) sin importar la posición deseada.
        var result = Resolve("$value", ControlDataType.Number, value);

        Assert.Equal(expected, result);
    }

    [Fact]
    public void StaticLiteralParameter_IsNeverOverriddenByRuntimeValue()
    {
        // Ej. controls/mcdu.yaml: parameter: 1 fijo para un botón momentáneo --
        // debe conservar el literal del perfil sin importar 'value'.
        var result = Resolve("1", ControlDataType.Boolean, false);

        Assert.Equal("1", result);
    }

    [Fact]
    public void NullParameter_IsPreservedAsNull()
    {
        var result = Resolve(null, ControlDataType.Boolean, true);

        Assert.Null(result);
    }

    [Fact]
    public void CompositeTemplate_ReplacesOnlyDynamicPlaceholder()
    {
        var result = Resolve("1|$value|0", ControlDataType.Number, 2d);

        Assert.Equal("1|2|0", result);
    }

    [Theory]
    [InlineData(0d, "1|0|0")]
    [InlineData(10d, "1|1|0")]
    [InlineData(20d, "1|2|0")]
    public void IflyApuTemplate_MapsAnimatedLvarBandsToSdkStates(double value, string expected)
    {
        var result = Resolve("1|$ifly_apu_state|0", ControlDataType.Number, value);

        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData(0d, "1|0|0")]
    [InlineData(4d, "1|0|0")]
    [InlineData(5d, "1|1|0")]
    [InlineData(10d, "1|1|0")]
    public void IflyBoolTemplate_MapsAnimatedBandsToBooleanSdkStates(double value, string expected)
    {
        var result = Resolve("1|$ifly_bool_state|0", ControlDataType.Number, value);

        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData(0d, "1|0|0")]
    [InlineData(10d, "1|1|0")]
    [InlineData(20d, "1|2|0")]
    public void IflyThreeStateTemplate_MapsAnimatedBandsToSdkStates(double value, string expected)
    {
        var result = Resolve("1|$ifly_three_state|0", ControlDataType.Number, value);

        Assert.Equal(expected, result);
    }
}
