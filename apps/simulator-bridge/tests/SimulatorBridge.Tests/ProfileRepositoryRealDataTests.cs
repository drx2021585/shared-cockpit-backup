using SharedCockpit.Bridge.Logging;
using SharedCockpit.Bridge.Profiles;
using Xunit;

namespace SimulatorBridge.Tests;

/// <summary>
/// Carga los perfiles REALES de aircraft-profiles/ (no fixtures) para
/// confirmar que el bridge efectivamente puede parsear lo que
/// aircraft-profiles-agent ya publicó en el repo, y que se respeta la regla
/// anti-TOGGLE del CLAUDE.md raíz.
/// </summary>
public class ProfileRepositoryRealDataTests
{
    private static string FindAircraftProfilesRoot()
    {
        var root = ProfileRepository.DiscoverRoot(AppContext.BaseDirectory);
        Assert.True(root is not null, "No se encontró aircraft-profiles/ subiendo desde el directorio de test. " +
            "¿Se movió la carpeta tests/ fuera de apps/simulator-bridge/?");
        return root!;
    }

    [Fact]
    public void ListsBothExampleProfiles()
    {
        var repo = new ProfileRepository(FindAircraftProfilesRoot());
        var ids = repo.ListProfileIds();

        Assert.Contains("cessna-172", ids);
        Assert.Contains("pmdg-737-900", ids);
    }

    [Fact]
    public void Cessna172_LoadsBeaconAndParkingBrakeControls_WithExplicitSetEvents()
    {
        var repo = new ProfileRepository(FindAircraftProfilesRoot());
        var profile = repo.LoadOne("cessna-172", SimulatorVersion.Msfs2024);

        var beacon = profile.FindControl("lights.beacon");
        Assert.NotNull(beacon);
        Assert.Equal(ControlDataType.Boolean, beacon!.DataType);
        Assert.Equal(ReadType.Simvar, beacon.Read.Type);
        Assert.Equal("LIGHT BEACON", beacon.Read.Name);
        Assert.Equal(WriteType.InputEvent, beacon.Write.Type);
        Assert.Equal("BEACON_LIGHTS_SET", beacon.Write.Name);
        Assert.True(beacon.Synchronization.ConfirmAfterWrite);

        var parkingBrake = profile.FindControl("ground.parking_brake");
        Assert.NotNull(parkingBrake);
        Assert.Equal("BRAKE PARKING POSITION", parkingBrake!.Read.Name);
        Assert.Equal("PARKING_BRAKE_SET", parkingBrake.Write.Name);
    }

    [Fact]
    public void Cessna172_DetectionRuleMatchesManifestId()
    {
        var repo = new ProfileRepository(FindAircraftProfilesRoot());
        var profile = repo.LoadOne("cessna-172", SimulatorVersion.Msfs2024);

        Assert.Equal("cessna-172", profile.Manifest.Aircraft.Id);
        Assert.Contains("Cessna Skyhawk", profile.Detection.TitleContains);
        Assert.True(profile.Detection.FallbackToPartialMatch);
    }

    [Fact]
    public void FlightControlAxes_AreMarkedAsFastChannel_OverheadSwitchesAreNot()
    {
        var repo = new ProfileRepository(FindAircraftProfilesRoot());
        var profile = repo.LoadOne("cessna-172", SimulatorVersion.Msfs2024);

        var yoke = profile.FindControl("flight.yoke.pitch");
        Assert.NotNull(yoke);
        Assert.True(yoke!.UsesFastChannel, "Un eje continuo (polled) debe ir por el canal rápido (control.axis).");

        var beacon = profile.FindControl("lights.beacon");
        Assert.NotNull(beacon);
        Assert.False(beacon!.UsesFastChannel, "Un interruptor (event) debe ir por el canal confiable (control.event).");
    }

    /// <summary>
    /// Red de seguridad anti-TOGGLE (CLAUDE.md raíz / packages/protocol/README.md):
    /// ningún control cuyo write.type sea inputEvent debe apuntar a un evento cuyo
    /// nombre sugiera un pulso TOGGLE crudo en vez de un SET explícito.
    /// </summary>
    [Theory]
    [InlineData("cessna-172")]
    [InlineData("pmdg-737-900")]
    public void NoControl_UsesRawToggleEventName(string profileId)
    {
        var repo = new ProfileRepository(FindAircraftProfilesRoot());
        var profile = repo.LoadOne(profileId, SimulatorVersion.Msfs2024);

        foreach (var control in profile.Controls)
        {
            if (control.Write.Type == WriteType.InputEvent)
            {
                Assert.False(
                    control.Write.Name.Contains("TOGGLE", StringComparison.OrdinalIgnoreCase),
                    $"Control '{control.Id}' en perfil '{profileId}' usa un evento TOGGLE crudo ('{control.Write.Name}'), viola la regla anti-toggle.");
            }
        }
    }

    [Fact]
    public void AllProfilesInRepo_ParseWithoutThrowing()
    {
        // aircraft-profiles/ también contiene fixtures mínimos usados por
        // tools/validate_profiles.py (ej. "test-aircraft", "default-a320") que
        // pueden no declarar controles; el bridge solo debe garantizar que
        // cargarlos no lanza una excepción, no que tengan contenido específico.
        var repo = new ProfileRepository(FindAircraftProfilesRoot());
        var log = new ConsoleLog();

        var profiles = repo.LoadAll(SimulatorVersion.Msfs2024, log);

        Assert.True(profiles.Count >= 2);

        var cessna = profiles.Single(p => p.ProfileId == "cessna-172");
        var pmdg = profiles.Single(p => p.ProfileId == "pmdg-737-900");
        Assert.NotEmpty(cessna.Controls);
        Assert.NotEmpty(pmdg.Controls);
    }
}
