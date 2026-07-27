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

    /// <summary>
    /// Lectura contra un Client Data Area de un SDK de terceros (ej.
    /// PMDG_NG3_Data). Requiere AreaName/Field/NativeType en
    /// ControlReadDefinition en vez de Name. Ver
    /// SimConnectInterop/PmdgClientDataClient.cs.
    /// </summary>
    ClientDataArea,
}

public enum WriteType
{
    InputEvent,
    Hvar,
    CalculatorCode,

    /// <summary>
    /// Escritura contra un Client Data Area de control de un SDK de terceros
    /// (ej. PMDG_NG3_Control {Event, Parameter}). Requiere AreaName/Event/
    /// Semantics en ControlWriteDefinition en vez de Name.
    /// </summary>
    ClientDataEvent,

    /// <summary>
    /// Evento NATIVO de SimConnect (no propietario de un addon) transmitido vía
    /// TransmitClientEvent estándar con un valor numérico FIJO por control (a
    /// diferencia de InputEvent, que deriva 0/1 del valor boolean en tiempo de
    /// escritura). Ej. PMDG NG3 reutiliza el evento nativo "ROTOR_BRAKE" como
    /// bus genérico de switches -- ver controls/native-toggle-switches.yaml.
    /// Requiere Name/Parameter/Semantics en ControlWriteDefinition.
    /// </summary>
    NativeEventValue,
}

public enum SyncMode
{
    Event,
    Polled,
}

/// <summary>
/// Tipo nativo del campo C dentro de un Client Data Area de un SDK de
/// terceros, usado para calcular offset/tamaño dentro del struct binario.
/// Ver packages/profile-schema/control.schema.json (read.nativeType).
/// </summary>
public enum ClientDataNativeType
{
    Bool,
    UChar,
    UInt,
    CharArray,
}

/// <summary>
/// Nivel de SDK que requiere un control. "StandardSimConnect" (default) usa
/// solo la API pública de SimConnect; "ClientDataArea" requiere además el SDK
/// de un addon de terceros con broadcast de datos habilitado por el usuario
/// (ej. PMDG_NG3_SDK.h + EnableDataBroadcast=1). El bridge debe poder hacer
/// fallback sin crashear si ese SDK de terceros no está disponible.
/// </summary>
public enum ControlSdkTier
{
    StandardSimConnect,
    ClientDataArea,
}

public sealed class ControlReadDefinition
{
    public ReadType Type { get; set; }

    /// <summary>Solo para la forma estándar (simvar/lvar/hvar).</summary>
    public string Name { get; set; } = string.Empty;

    // --- Solo para ReadType.ClientDataArea ---
    public string? AreaName { get; set; }
    public string? Field { get; set; }
    public int? ArrayIndex { get; set; }
    public ClientDataNativeType? NativeType { get; set; }
}

public sealed class ControlWriteDefinition
{
    public WriteType Type { get; set; }

    /// <summary>Solo para la forma estándar (inputEvent/hvar/calculatorCode).</summary>
    public string Name { get; set; } = string.Empty;

    // --- Solo para WriteType.ClientDataEvent ---
    public string? AreaName { get; set; }
    public string? Event { get; set; }
    public string? Parameter { get; set; }
    public string? Semantics { get; set; }
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

    /// <summary>Default StandardSimConnect si el perfil no lo declara (retrocompatible).</summary>
    public ControlSdkTier SdkTier { get; set; } = ControlSdkTier.StandardSimConnect;

    /// <summary>
    /// True si y solo si el control no declara 'write' (ver
    /// packages/profile-schema/control.schema.json "readOnly"). Cuando es true,
    /// Write es null y el bridge NUNCA debe intentar escribir este control (ver
    /// Bridge/BridgeService.WriteControl).
    /// </summary>
    public bool ReadOnly { get; set; }

    /// <summary>
    /// True si y solo si el control no declara 'read' (ver
    /// packages/profile-schema/control.schema.json "writeOnly"). Cuando es true,
    /// Read es null y el bridge NUNCA debe intentar suscribir/leer este control
    /// (ver Bridge/BridgeService.SubscribeControls). Usado por los botones
    /// momentáneos del CDU/MCDU (controls/mcdu.yaml).
    /// </summary>
    public bool WriteOnly { get; set; }

    /// <summary>Null cuando WriteOnly es true (el control no tiene bloque 'read' en el YAML).</summary>
    public ControlReadDefinition? Read { get; set; }

    /// <summary>Null cuando ReadOnly es true (el control no tiene bloque 'write' en el YAML).</summary>
    public ControlWriteDefinition? Write { get; set; }

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
