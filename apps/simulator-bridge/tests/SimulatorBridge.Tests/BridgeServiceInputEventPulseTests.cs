using System.Reflection;
using SharedCockpit.Bridge.Bridge;
using SharedCockpit.Bridge.Profiles;
using Xunit;

namespace SimulatorBridge.Tests;

/// <summary>
/// Cubre BridgeService.ResolveInputEventPulse -- convención "eventoSiTrue|eventoSiFalse"
/// para write.type: inputEvent, usada para corregir el bug real de
/// flight.gear (aircraft-profiles/pmdg-737-900/EVENT_IDS_PENDIENTES.md,
/// sección "Landing gear lever -> solo sube no baja"): el PMDG NG3 nunca
/// escuchaba K:GEAR_SET (el único evento que este control transmitía antes),
/// solo los dos K:events legacy separados K:GEAR_UP/K:GEAR_DOWN -- de ahí que
/// "subir" pareciera funcionar (coincidencia con el sistema de tren por
/// defecto de MSFS) pero "bajar" nunca llegara al gauge de PMDG.
///
/// El método es privado y estático (detalle de implementación de
/// BridgeService) -- se invoca vía reflection, mismo patrón que
/// BridgeServiceWriteParameterTests.
/// </summary>
public class BridgeServiceInputEventPulseTests
{
    private static (string EventName, uint Data) Resolve(string declaredName, ControlDataType dataType, object value)
    {
        var method = typeof(BridgeService).GetMethod(
            "ResolveInputEventPulse",
            BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(method);

        var result = method!.Invoke(null, new object?[] { declaredName, dataType, value });
        Assert.NotNull(result);
        return ((string, uint))result!;
    }

    [Fact]
    public void PipePair_BooleanTrue_SelectsFirstEvent()
    {
        var (eventName, data) = Resolve("GEAR_DOWN|GEAR_UP", ControlDataType.Boolean, true);

        Assert.Equal("GEAR_DOWN", eventName);
        Assert.Equal(1u, data);
    }

    [Fact]
    public void PipePair_BooleanFalse_SelectsSecondEvent()
    {
        var (eventName, data) = Resolve("GEAR_DOWN|GEAR_UP", ControlDataType.Boolean, false);

        Assert.Equal("GEAR_UP", eventName);
        Assert.Equal(1u, data);
    }

    [Fact]
    public void NoPipe_PreservesHistoricalSingleEventBehavior()
    {
        // Ej. flight.flaps, flight.spoilers: un único evento *_SET con dwData
        // derivado del valor real -- comportamiento histórico, no debe cambiar.
        var (eventName, data) = Resolve("FLAPS_SET", ControlDataType.Number, 15d);

        Assert.Equal("FLAPS_SET", eventName);
        Assert.Equal(15u, data);
    }

    [Fact]
    public void NoPipe_Boolean_PreservesHistoricalDwDataFromValue()
    {
        var (eventNameTrue, dataTrue) = Resolve("SOME_SET", ControlDataType.Boolean, true);
        var (eventNameFalse, dataFalse) = Resolve("SOME_SET", ControlDataType.Boolean, false);

        Assert.Equal("SOME_SET", eventNameTrue);
        Assert.Equal(1u, dataTrue);
        Assert.Equal("SOME_SET", eventNameFalse);
        Assert.Equal(0u, dataFalse);
    }

    [Fact]
    public void PipeSeparator_IgnoredForNonBooleanDataType()
    {
        // La convención de '|' solo aplica a dataType boolean -- si un control
        // numérico tuviera '|' por error, no debe interpretarse como un par.
        var (eventName, _) = Resolve("A|B", ControlDataType.Number, 1d);

        Assert.Equal("A|B", eventName);
    }
}
