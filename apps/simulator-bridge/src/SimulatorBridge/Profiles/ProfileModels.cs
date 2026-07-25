namespace SharedCockpit.Bridge.Profiles;

/// <summary>
/// Modelos que espejan packages/profile-schema/*.schema.json. El bridge SOLO
/// consume estos archivos (aircraft-profiles/*), nunca los diseña ni los
/// modifica — el esquema y el contenido son propiedad de aircraft-profiles-agent.
/// </summary>
public sealed class AircraftManifest
{
    public int SchemaVersion { get; set; }
    public AircraftInfo Aircraft { get; set; } = new();
    public CompatibilityInfo Compatibility { get; set; } = new();
}

public sealed class AircraftInfo
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Developer { get; set; } = string.Empty;
}

public sealed class CompatibilityInfo
{
    public bool Msfs2020 { get; set; }
    public bool Msfs2024 { get; set; }
}

public sealed class DetectionRule
{
    public List<string> TitleContains { get; set; } = new();
    public bool FallbackToPartialMatch { get; set; }
}

public enum ControlDataType
{
    Boolean,
    Number,
    String,
}

public enum ControlAuthority
{
    Exclusive,
    Shared,
    CaptainOnly,
    FirstOfficerOnly,
    InstructorOnly,
    LocalOnly,
}

public enum ReadType
{
    Simvar,
    Lvar,
    Hvar,
}

public enum WriteType
{
    InputEvent,
    Hvar,
    CalculatorCode,
}

public enum SyncMode
{
    Event,
    Polled,
}

public sealed class ControlReadDefinition
{
    public ReadType Type { get; set; }
    public string Name { get; set; } = string.Empty;
}

public sealed class ControlWriteDefinition
{
    public WriteType Type { get; set; }
    public string Name { get; set; } = string.Empty;
}

public sealed class ControlSynchronization
{
    public SyncMode Mode { get; set; }
    public int DebounceMs { get; set; }
    public bool ConfirmAfterWrite { get; set; }
    public int TimeoutMs { get; set; }
}

public sealed class ControlDefinition
{
    public string Id { get; set; } = string.Empty;
    public ControlDataType DataType { get; set; }
    public ControlAuthority Authority { get; set; }
    public ControlReadDefinition Read { get; set; } = new();
    public ControlWriteDefinition Write { get; set; } = new();
    public ControlSynchronization Synchronization { get; set; } = new();

    /// <summary>Canal rápido (control.axis) si es polled y numérico continuo; confiable (control.event) si es event.</summary>
    public bool UsesFastChannel => Synchronization.Mode == SyncMode.Polled;
}

public sealed class MappingOverride
{
    public string ControlId { get; set; } = string.Empty;
    public ControlReadDefinition? Read { get; set; }
    public ControlWriteDefinition? Write { get; set; }
}

public sealed class AircraftMapping
{
    public List<MappingOverride> Overrides { get; set; } = new();
}

/// <summary>Perfil completo ya cargado y resuelto (manifest + detection + controles + overrides de la versión de sim activa).</summary>
public sealed class AircraftProfile
{
    public required string ProfileId { get; init; }
    public required AircraftManifest Manifest { get; init; }
    public required DetectionRule Detection { get; init; }
    public required IReadOnlyList<ControlDefinition> Controls { get; init; }

    public ControlDefinition? FindControl(string controlId) =>
        Controls.FirstOrDefault(c => c.Id == controlId);
}
