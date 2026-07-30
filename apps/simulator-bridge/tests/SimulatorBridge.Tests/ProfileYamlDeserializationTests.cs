using SharedCockpit.Bridge.Profiles;
using Xunit;

namespace SimulatorBridge.Tests;

/// <summary>
/// Cubre la deserialización NUEVA introducida para read.type: clientDataArea,
/// write.type: clientDataEvent y sdkTier (ver ProfileYamlDto.cs / ProfileModels.cs /
/// ProfileRepository.cs). Ningún perfil real en aircraft-profiles/ usa todavía
/// estas formas (el SDK oficial de PMDG sigue bloqueado, ver docs/plan-maestro.md
/// Fase 7), así que estos tests usan fixtures YAML mínimos escritos a un
/// directorio temporal con la misma estructura que espera ProfileRepository
/// (manifest.yaml, detection.yaml, controls/*.yaml), en vez de depender de
/// aircraft-profiles/ real. Esto también es exactamente el "romper a
/// propósito" que le toca a tests/: confirma que el nuevo camino de
/// deserialización tolera perfiles retrocompatibles (sin sdkTier) y no
/// rompe silenciosamente perfiles antiguos.
/// </summary>
public sealed class ProfileYamlDeserializationTests : IDisposable
{
    private readonly string _root;

    public ProfileYamlDeserializationTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "sc-profile-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_root);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }

    private string WriteProfile(string profileId, string controlsYaml)
    {
        var dir = Path.Combine(_root, profileId);
        Directory.CreateDirectory(Path.Combine(dir, "controls"));

        File.WriteAllText(Path.Combine(dir, "manifest.yaml"), $"""
            schemaVersion: 1
            aircraft:
              id: {profileId}
              name: Test Aircraft
              developer: Test Dev
            compatibility:
              msfs2020: true
              msfs2024: false
            """);

        File.WriteAllText(Path.Combine(dir, "detection.yaml"), """
            titleContains:
              - "Test Aircraft"
            fallbackToPartialMatch: true
            """);

        File.WriteAllText(Path.Combine(dir, "controls", "test.yaml"), controlsYaml);

        return _root;
    }

    [Fact]
    public void ClientDataArea_Read_DeserializesAreaFieldArrayIndexAndNativeType()
    {
        var root = WriteProfile("pmdg-cda-read", """
            - id: autopilot.irs_mode_selector
              dataType: number
              authority: shared
              sdkTier: clientDataArea
              read:
                type: clientDataArea
                areaName: PMDG_NG3_Data
                field: IRS_ModeSelector
                arrayIndex: 2
                nativeType: uchar
              write:
                type: clientDataEvent
                areaName: PMDG_NG3_Control
                event: "1234"
                parameter: "0"
                semantics: sets IRS mode selector to NAV
              synchronization:
                mode: event
                debounceMs: 100
                confirmAfterWrite: true
                timeoutMs: 1000
            """);

        var repo = new ProfileRepository(root);
        var profile = repo.LoadOne("pmdg-cda-read", SimulatorVersion.Msfs2020);

        var control = profile.FindControl("autopilot.irs_mode_selector");
        Assert.NotNull(control);
        Assert.Equal(ControlSdkTier.ClientDataArea, control!.SdkTier);

        Assert.Equal(ReadType.ClientDataArea, control.Read!.Type);
        Assert.Equal("PMDG_NG3_Data", control.Read.AreaName);
        Assert.Equal("IRS_ModeSelector", control.Read.Field);
        Assert.Equal(2, control.Read.ArrayIndex);
        Assert.Equal(ClientDataNativeType.UChar, control.Read.NativeType);
        // La forma clientDataArea no usa Name (queda vacío, distinto de la forma estándar).
        Assert.Equal(string.Empty, control.Read.Name);
    }

    [Fact]
    public void ClientDataEvent_Write_DeserializesAreaEventParameterAndSemantics()
    {
        var root = WriteProfile("pmdg-cda-write", """
            - id: autopilot.irs_mode_selector
              dataType: number
              authority: shared
              sdkTier: clientDataArea
              read:
                type: clientDataArea
                areaName: PMDG_NG3_Data
                field: IRS_ModeSelector
                nativeType: uchar
              write:
                type: clientDataEvent
                areaName: PMDG_NG3_Control
                event: "1234"
                parameter: "0"
                semantics: sets IRS mode selector to NAV
              synchronization:
                mode: event
                debounceMs: 100
                confirmAfterWrite: true
                timeoutMs: 1000
            """);

        var repo = new ProfileRepository(root);
        var profile = repo.LoadOne("pmdg-cda-write", SimulatorVersion.Msfs2020);

        var control = profile.FindControl("autopilot.irs_mode_selector");
        Assert.NotNull(control);
        Assert.NotNull(control!.Write);
        Assert.Equal(WriteType.ClientDataEvent, control.Write!.Type);
        Assert.Equal("PMDG_NG3_Control", control.Write.AreaName);
        Assert.Equal("1234", control.Write.Event);
        Assert.Equal("0", control.Write.Parameter);
        Assert.Equal("sets IRS mode selector to NAV", control.Write.Semantics);
        // La forma clientDataEvent no usa Name (queda vacío, distinto de la forma estándar).
        Assert.Equal(string.Empty, control.Write.Name);
    }

    [Fact]
    public void SdkTier_DefaultsToStandardSimConnect_WhenOmitted_ForRetrocompatibility()
    {
        // Perfil "viejo" tal cual existía antes de esta noche: sin sdkTier,
        // formas estándar de read/write. Debe seguir deserializando igual que
        // siempre (retrocompatibilidad explícita, ver ProfileEnumMapper.SdkTier).
        var root = WriteProfile("legacy-profile", """
            - id: lights.beacon
              dataType: boolean
              authority: shared
              read:
                type: simvar
                name: "LIGHT BEACON"
              write:
                type: inputEvent
                name: "BEACON_LIGHTS_SET"
              synchronization:
                mode: event
                debounceMs: 100
                confirmAfterWrite: true
                timeoutMs: 1000
            """);

        var repo = new ProfileRepository(root);
        var profile = repo.LoadOne("legacy-profile", SimulatorVersion.Msfs2020);

        var control = profile.FindControl("lights.beacon");
        Assert.NotNull(control);
        Assert.Equal(ControlSdkTier.StandardSimConnect, control!.SdkTier);
        Assert.Equal(ReadType.Simvar, control.Read!.Type);
        Assert.Equal("LIGHT BEACON", control.Read.Name);
        Assert.NotNull(control.Write);
        Assert.Equal(WriteType.InputEvent, control.Write!.Type);
        Assert.Equal("BEACON_LIGHTS_SET", control.Write.Name);
    }

    [Fact]
    public void SdkTier_ExplicitStandardSimConnect_ParsesTheSameAsOmitted()
    {
        var root = WriteProfile("explicit-standard-tier", """
            - id: lights.nav
              dataType: boolean
              authority: shared
              sdkTier: standardSimConnect
              read:
                type: simvar
                name: "LIGHT NAV"
              write:
                type: inputEvent
                name: "NAV_LIGHTS_SET"
              synchronization:
                mode: event
                debounceMs: 100
                confirmAfterWrite: true
                timeoutMs: 1000
            """);

        var repo = new ProfileRepository(root);
        var profile = repo.LoadOne("explicit-standard-tier", SimulatorVersion.Msfs2020);

        var control = profile.FindControl("lights.nav");
        Assert.NotNull(control);
        Assert.Equal(ControlSdkTier.StandardSimConnect, control!.SdkTier);
    }

    [Fact]
    public void UnknownSdkTier_ThrowsInsteadOfSilentlyDefaulting()
    {
        // ProfileEnumMapper.SdkTier lanza NotSupportedException para valores no
        // contemplados en vez de asumir un default silencioso — mejor fallar
        // ruidosamente (ver comentario en ProfileEnumMapper.cs).
        var root = WriteProfile("bad-sdk-tier", """
            - id: lights.beacon
              dataType: boolean
              authority: shared
              sdkTier: totallyMadeUpTier
              read:
                type: simvar
                name: "LIGHT BEACON"
              write:
                type: inputEvent
                name: "BEACON_LIGHTS_SET"
              synchronization:
                mode: event
                debounceMs: 100
                confirmAfterWrite: true
                timeoutMs: 1000
            """);

        var repo = new ProfileRepository(root);
        Assert.Throws<NotSupportedException>(() => repo.LoadOne("bad-sdk-tier", SimulatorVersion.Msfs2020));
    }

    [Fact]
    public void MixedProfile_StandardAndClientDataControls_BothLoadCorrectly()
    {
        // Un perfil real de tercero probablemente mezcle controles estándar
        // (simvars/eventos K:) con un subconjunto que sí usa el SDK del addon.
        // Confirma que ambas formas conviven sin que una rompa el parseo de la otra.
        var root = WriteProfile("mixed-profile", """
            - id: lights.beacon
              dataType: boolean
              authority: shared
              read:
                type: simvar
                name: "LIGHT BEACON"
              write:
                type: inputEvent
                name: "BEACON_LIGHTS_SET"
              synchronization:
                mode: event
                debounceMs: 100
                confirmAfterWrite: true
                timeoutMs: 1000

            - id: autopilot.irs_mode_selector
              dataType: number
              authority: shared
              sdkTier: clientDataArea
              read:
                type: clientDataArea
                areaName: PMDG_NG3_Data
                field: IRS_ModeSelector
                nativeType: uchar
              write:
                type: clientDataEvent
                areaName: PMDG_NG3_Control
                event: "1234"
                semantics: sets IRS mode selector to NAV
              synchronization:
                mode: event
                debounceMs: 100
                confirmAfterWrite: true
                timeoutMs: 1000
            """);

        var repo = new ProfileRepository(root);
        var profile = repo.LoadOne("mixed-profile", SimulatorVersion.Msfs2020);

        Assert.Equal(2, profile.Controls.Count);
        Assert.Equal(ReadType.Simvar, profile.FindControl("lights.beacon")!.Read!.Type);
        Assert.Equal(ReadType.ClientDataArea, profile.FindControl("autopilot.irs_mode_selector")!.Read!.Type);
    }

    /// <summary>
    /// Cubre la extensión más reciente del esquema (2026-07-25, ver
    /// packages/profile-schema/control.schema.json "readOnly"): un control
    /// puede omitir 'write' por completo si declara 'readOnly: true'
    /// explícito. Usado por los ~50 anunciadores ELEC_*/HYD_* reales del PMDG
    /// NG3 agregados esta noche a aircraft-profiles/pmdg-737-900/controls/.
    /// </summary>
    [Fact]
    public void ReadOnlyControl_WithoutWriteBlock_DeserializesWithNullWrite()
    {
        var root = WriteProfile("readonly-profile", """
            - id: electrical.annun_bat_discharge
              dataType: boolean
              authority: shared
              readOnly: true
              sdkTier: clientDataArea
              read:
                type: clientDataArea
                areaName: PMDG_NG3_Data
                field: annunBAT_DISCHARGE
                nativeType: bool
              synchronization:
                mode: event
                debounceMs: 100
                confirmAfterWrite: false
                timeoutMs: 1000
            """);

        var repo = new ProfileRepository(root);
        var profile = repo.LoadOne("readonly-profile", SimulatorVersion.Msfs2020);

        var control = profile.FindControl("electrical.annun_bat_discharge");
        Assert.NotNull(control);
        Assert.True(control!.ReadOnly);
        Assert.Null(control.Write);
        Assert.Equal(ReadType.ClientDataArea, control.Read!.Type);
        Assert.Equal("annunBAT_DISCHARGE", control.Read.Field);
    }

    /// <summary>
    /// Cubre la extensión más reciente del esquema (2026-07-26, ver
    /// packages/profile-schema/control.schema.json "writeOnly"): un control
    /// puede omitir 'read' por completo si declara 'writeOnly: true' explícito.
    /// Usado por los 140 botones momentáneos del CDU/MCDU reales del PMDG NG3
    /// agregados esta noche a aircraft-profiles/pmdg-737-900/controls/mcdu.yaml.
    /// </summary>
    [Fact]
    public void WriteOnlyControl_WithoutReadBlock_DeserializesWithNullRead()
    {
        var root = WriteProfile("writeonly-profile", """
            - id: mcdu.captain.key_l1
              dataType: boolean
              authority: shared
              sdkTier: clientDataArea
              writeOnly: true
              write:
                type: clientDataEvent
                areaName: PMDG_NG3_Control
                event: "EVT_CDU_L_L1"
                parameter: 1
                semantics: presses CDU L L1 key
              synchronization:
                mode: event
                confirmAfterWrite: false
                debounceMs: 150
            """);

        var repo = new ProfileRepository(root);
        var profile = repo.LoadOne("writeonly-profile", SimulatorVersion.Msfs2020);

        var control = profile.FindControl("mcdu.captain.key_l1");
        Assert.NotNull(control);
        Assert.True(control!.WriteOnly);
        Assert.False(control.ReadOnly);
        Assert.Null(control.Read);
        Assert.NotNull(control.Write);
        Assert.Equal(WriteType.ClientDataEvent, control.Write!.Type);
        Assert.Equal("EVT_CDU_L_L1", control.Write.Event);
    }

    [Fact]
    public void ScreenDefinitions_FromScreensYaml_DeserializeCorrectly()
    {
        var dir = Path.Combine(_root, "screen-profile");
        Directory.CreateDirectory(Path.Combine(dir, "controls"));
        Directory.CreateDirectory(Path.Combine(dir, "screens"));

        File.WriteAllText(Path.Combine(dir, "manifest.yaml"), """
            schemaVersion: 1
            aircraft:
              id: screen-profile
              name: Test Aircraft
              developer: Test Dev
            compatibility:
              msfs2020: true
              msfs2024: false
            """);

        File.WriteAllText(Path.Combine(dir, "detection.yaml"), """
            titleContains:
              - "Test Aircraft"
            fallbackToPartialMatch: true
            """);

        File.WriteAllText(Path.Combine(dir, "controls", "test.yaml"), """
            - id: lights.beacon
              dataType: boolean
              authority: shared
              read:
                type: simvar
                name: "LIGHT BEACON"
              write:
                type: inputEvent
                name: "BEACON_LIGHTS_SET"
              synchronization:
                mode: event
                debounceMs: 100
                confirmAfterWrite: true
                timeoutMs: 1000
            """);

        File.WriteAllText(Path.Combine(dir, "screens", "cdu.yaml"), """
            - id: cdu_captain
              areaName: PMDG_NG3_CDU_0
              rows: 14
              cols: 24
              sdkTier: clientDataArea
              readOnly: true
              poweredField: Powered
              cell:
                charField: Symbol
                colorField: Color
                flagsField: Flags
                colorValues: 6
            """);

        var repo = new ProfileRepository(_root);
        var profile = repo.LoadOne("screen-profile", SimulatorVersion.Msfs2020);

        var screen = profile.FindScreen("cdu_captain");
        Assert.NotNull(screen);
        Assert.Equal("PMDG_NG3_CDU_0", screen!.AreaName);
        Assert.Equal(14, screen.Rows);
        Assert.Equal(24, screen.Cols);
        Assert.Equal(ScreenSdkTier.ClientDataArea, screen.SdkTier);
        Assert.True(screen.ReadOnly);
        Assert.Equal("Powered", screen.PoweredField);
        Assert.Equal("Symbol", screen.Cell.CharField);
        Assert.Equal("Color", screen.Cell.ColorField);
        Assert.Equal("Flags", screen.Cell.FlagsField);
        Assert.Equal(6, screen.Cell.ColorValues);
    }

    [Fact]
    public void WritableControl_DoesNotSetReadOnly()
    {
        var root = WriteProfile("writable-profile", """
            - id: lights.beacon
              dataType: boolean
              authority: shared
              read:
                type: simvar
                name: "LIGHT BEACON"
              write:
                type: inputEvent
                name: "BEACON_LIGHTS_SET"
              synchronization:
                mode: event
                debounceMs: 100
                confirmAfterWrite: true
                timeoutMs: 1000
            """);

        var repo = new ProfileRepository(root);
        var profile = repo.LoadOne("writable-profile", SimulatorVersion.Msfs2020);

        var control = profile.FindControl("lights.beacon");
        Assert.NotNull(control);
        Assert.False(control!.ReadOnly);
        Assert.NotNull(control.Write);
    }
}
