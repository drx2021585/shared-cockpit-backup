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
        var profile = repo.LoadOne("cessna-172", SimulatorVersion.Msfs2020);

        var beacon = profile.FindControl("lights.beacon");
        Assert.NotNull(beacon);
        Assert.Equal(ControlDataType.Boolean, beacon!.DataType);
        Assert.Equal(ReadType.Simvar, beacon.Read!.Type);
        Assert.Equal("LIGHT BEACON", beacon.Read.Name);
        Assert.NotNull(beacon.Write);
        Assert.Equal(WriteType.InputEvent, beacon.Write!.Type);
        Assert.Equal("BEACON_LIGHTS_SET", beacon.Write.Name);
        Assert.True(beacon.Synchronization.ConfirmAfterWrite);

        var parkingBrake = profile.FindControl("ground.parking_brake");
        Assert.NotNull(parkingBrake);
        Assert.Equal("BRAKE PARKING POSITION", parkingBrake!.Read!.Name);
        Assert.NotNull(parkingBrake.Write);
        Assert.Equal("PARKING_BRAKE_SET", parkingBrake.Write!.Name);
    }

    [Fact]
    public void Cessna172_DetectionRuleMatchesManifestId()
    {
        var repo = new ProfileRepository(FindAircraftProfilesRoot());
        var profile = repo.LoadOne("cessna-172", SimulatorVersion.Msfs2020);

        Assert.Equal("cessna-172", profile.Manifest.Aircraft.Id);
        Assert.Contains("Cessna Skyhawk", profile.Detection.TitleContains);
        Assert.True(profile.Detection.FallbackToPartialMatch);
    }

    [Fact]
    public void FlightControlAxes_AreMarkedAsFastChannel_OverheadSwitchesAreNot()
    {
        var repo = new ProfileRepository(FindAircraftProfilesRoot());
        var profile = repo.LoadOne("cessna-172", SimulatorVersion.Msfs2020);

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
        var profile = repo.LoadOne(profileId, SimulatorVersion.Msfs2020);

        foreach (var control in profile.Controls)
        {
            // Controles readOnly (ej. anunciadores del PMDG NG3 SDK) no declaran
            // 'write' -- no hay nada que verificar contra TOGGLE ahí.
            if (control.Write is { Type: WriteType.InputEvent } write)
            {
                Assert.False(
                    write.Name.Contains("TOGGLE", StringComparison.OrdinalIgnoreCase),
                    $"Control '{control.Id}' en perfil '{profileId}' usa un evento TOGGLE crudo ('{write.Name}'), viola la regla anti-toggle.");
            }
        }
    }

    /// <summary>
    /// LoadOne (a diferencia de LoadAll) NO atrapa excepciones -- es la prueba
    /// más directa de que el deserializador soporta de verdad los ~50 controles
    /// readOnly:true (sin bloque 'write') que aircraft-profiles-agent agregó
    /// esta noche a electrical.yaml / hydraulics.yaml del PMDG 737-900. Si el
    /// DTO/modelo no soportaran 'write' opcional, esto lanzaría
    /// NotSupportedException en ProfileEnumMapper.WriteType("").
    /// </summary>
    [Fact]
    public void Pmdg737900_LoadsRealReadOnlyControls_WithoutThrowing()
    {
        var repo = new ProfileRepository(FindAircraftProfilesRoot());
        var profile = repo.LoadOne("pmdg-737-900", SimulatorVersion.Msfs2020);

        var readOnlyControls = profile.Controls.Where(c => c.ReadOnly).ToList();
        Assert.True(readOnlyControls.Count > 0,
            "Se esperaban controles readOnly:true (anunciadores ELEC_*/HYD_* del PMDG NG3) en el perfil real.");

        foreach (var control in readOnlyControls)
        {
            Assert.Null(control.Write);
        }

        var writableControls = profile.Controls.Where(c => !c.ReadOnly).ToList();
        foreach (var control in writableControls)
        {
            Assert.NotNull(control.Write);
        }
    }

    [Fact]
    public void Cessna172_LoadsRealProfile_WithoutThrowing()
    {
        var repo = new ProfileRepository(FindAircraftProfilesRoot());
        var profile = repo.LoadOne("cessna-172", SimulatorVersion.Msfs2020);

        Assert.NotEmpty(profile.Controls);
        Assert.All(profile.Controls, c => Assert.False(c.ReadOnly, "cessna-172 no debería tener controles readOnly hoy."));
    }

    /// <summary>
    /// Cubre los dos controles ESCRIBIBLES nuevos que aircraft-profiles-agent
    /// agregó a controls/lights.yaml del PMDG 737-900 (2026-07-26), que además
    /// no son idénticos entre sí -- confirma que el deserializador/loader real
    /// soporta ambas variantes con datos reales del repo, no solo fixtures:
    ///   - lights.taxi: read.type clientDataArea + write.type clientDataEvent
    ///     (área de control PMDG_NG3_Control, Event "EVT_OH_LIGHTS_TAXI").
    ///   - lights.logo: read.type clientDataArea (misma área de datos) pero
    ///     write.type inputEvent con name "#69754" (SimConnect estándar,
    ///     NO clientDataEvent) -- un control puede mezclar sdkTier: clientDataArea
    ///     en lectura con un evento de escritura estándar; esto NO es un bug,
    ///     es intencional (ver comentario en lights.yaml), pero no hay
    ///     cobertura previa de esta combinación mixta lectura-CDA/escritura-estándar
    ///     con datos reales, solo con fixtures sintéticos (ver
    ///     ProfileYamlDeserializationTests.MixedProfile_..., que mezcla dos
    ///     controles separados, no un mismo control con read/write de dos
    ///     mundos distintos).
    /// </summary>
    [Fact]
    public void Pmdg737900_LoadsNewWritableLightsControls_TaxiViaClientDataEvent_LogoViaInputEvent()
    {
        var repo = new ProfileRepository(FindAircraftProfilesRoot());
        var profile = repo.LoadOne("pmdg-737-900", SimulatorVersion.Msfs2020);

        var taxi = profile.FindControl("lights.taxi");
        Assert.NotNull(taxi);
        Assert.False(taxi!.ReadOnly);
        Assert.Equal(ReadType.ClientDataArea, taxi.Read!.Type);
        Assert.Equal("PMDG_NG3_Data", taxi.Read.AreaName);
        Assert.Equal("LTS_TaxiSw", taxi.Read.Field);
        Assert.NotNull(taxi.Write);
        Assert.Equal(WriteType.ClientDataEvent, taxi.Write!.Type);
        Assert.Equal("PMDG_NG3_Control", taxi.Write.AreaName);
        Assert.Equal("EVT_OH_LIGHTS_TAXI", taxi.Write.Event);
        Assert.False(string.IsNullOrWhiteSpace(taxi.Write.Semantics), "clientDataEvent debe traer semantics no vacía (regla anti-toggle).");
        Assert.False(
            taxi.Write.Semantics.Trim().Equals("toggle", StringComparison.OrdinalIgnoreCase) ||
            taxi.Write.Semantics.Trim().Equals("toggles", StringComparison.OrdinalIgnoreCase),
            "semantics no debe ser un TOGGLE crudo disfrazado.");

        var logo = profile.FindControl("lights.logo");
        Assert.NotNull(logo);
        Assert.False(logo!.ReadOnly);
        Assert.Equal(ReadType.ClientDataArea, logo.Read!.Type);
        Assert.Equal("LTS_LogoSw", logo.Read.Field);
        Assert.NotNull(logo.Write);
        Assert.Equal(WriteType.InputEvent, logo.Write!.Type);
        Assert.Equal("#69754", logo.Write.Name);
        Assert.False(
            logo.Write.Name.Contains("TOGGLE", StringComparison.OrdinalIgnoreCase),
            "lights.logo usa un ID de evento numérico crudo ('#69754'), no debe colarse una variante con 'TOGGLE' en el nombre.");
    }

    /// <summary>
    /// LoadOne NO atrapa excepciones -- es la prueba más directa de que el
    /// deserializador soporta de verdad los 140 controles writeOnly:true (sin
    /// bloque 'read') que aircraft-profiles-agent agregó esta noche a
    /// controls/mcdu.yaml del PMDG 737-900 (botones momentáneos del CDU/MCDU,
    /// ver packages/profile-schema/README.md "Botones momentáneos"). Si el
    /// DTO/modelo no soportaran 'read' opcional, esto lanzaría
    /// NotSupportedException en ProfileEnumMapper.ReadType("") (mismo patrón de
    /// bug que readOnly/write hace algunas noches).
    /// </summary>
    [Fact]
    public void Pmdg737900_LoadsRealWriteOnlyMcduControls_WithoutThrowing()
    {
        var repo = new ProfileRepository(FindAircraftProfilesRoot());
        var profile = repo.LoadOne("pmdg-737-900", SimulatorVersion.Msfs2020);

        var writeOnlyControls = profile.Controls.Where(c => c.WriteOnly).ToList();
        Assert.True(writeOnlyControls.Count >= 140,
            "Se esperaban al menos 140 controles writeOnly:true (teclas EVT_CDU_L_*/EVT_CDU_R_*) en el perfil real.");

        foreach (var control in writeOnlyControls)
        {
            Assert.Null(control.Read);
            // MCDU/CDU (clientDataEvent) y algunos setters de MCP/autopiloto
            // (inputEvent, ej. "#84132") comparten writeOnly:true pero no el
            // mismo write.type -- solo se exige que exista ALGÚN bloque 'write'.
            Assert.NotNull(control.Write);
        }

        var readableControls = profile.Controls.Where(c => !c.WriteOnly).ToList();
        foreach (var control in readableControls)
        {
            Assert.NotNull(control.Read);
        }

        var captainL1 = profile.FindControl("mcdu.captain.key_l1");
        Assert.NotNull(captainL1);
        Assert.True(captainL1!.WriteOnly);
        Assert.Null(captainL1.Read);
        Assert.Equal("EVT_CDU_L_L1", captainL1.Write!.Event);
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

        var profiles = repo.LoadAll(SimulatorVersion.Msfs2020, log);

        Assert.True(profiles.Count >= 2);

        var cessna = profiles.Single(p => p.ProfileId == "cessna-172");
        var pmdg = profiles.Single(p => p.ProfileId == "pmdg-737-900");
        Assert.NotEmpty(cessna.Controls);
        Assert.NotEmpty(pmdg.Controls);
    }
}
