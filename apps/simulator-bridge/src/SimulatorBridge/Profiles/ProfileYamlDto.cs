namespace SharedCockpit.Bridge.Profiles;

/// <summary>
/// DTOs "crudos" para deserializar YAML tal cual está escrito en
/// aircraft-profiles/*/*.yaml (strings, no enums) antes de convertir a los
/// modelos fuertemente tipados de ProfileModels.cs. Se separan porque los
/// perfiles usan una mezcla de camelCase y kebab-case en los valores enum
/// (ej. "captain-only", "inputEvent") que conviene mapear a mano en vez de
/// confiar en la convención de nombres automática de YamlDotNet.
/// </summary>
public sealed class ManifestYamlDto
{
    public int SchemaVersion { get; set; }
    public AircraftInfoDto Aircraft { get; set; } = new();
    public CompatibilityDto Compatibility { get; set; } = new();
}

public sealed class AircraftInfoDto
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Developer { get; set; } = string.Empty;
}

public sealed class CompatibilityDto
{
    public bool Msfs2020 { get; set; }
    public bool Msfs2024 { get; set; }
}

public sealed class DetectionYamlDto
{
    public List<string> TitleContains { get; set; } = new();
    public bool FallbackToPartialMatch { get; set; }
}

public sealed class ControlReadDto
{
    public string Type { get; set; } = string.Empty;

    /// <summary>Usado por la forma estándar (simvar/lvar/hvar).</summary>
    public string Name { get; set; } = string.Empty;

    // --- Campos exclusivos de la forma clientDataArea (SDK de terceros, ej.
    // PMDG_NG3_SDK.h). Quedan vacíos/null en la forma estándar. Ver
    // packages/profile-schema/README.md "Controles vía SDK de terceros".
    /// <summary>Nombre del Client Data Area (ej. "PMDG_NG3_Data").</summary>
    public string? AreaName { get; set; }

    /// <summary>Nombre del campo C del struct (ej. "IRS_ModeSelector").</summary>
    public string? Field { get; set; }

    /// <summary>Índice, si Field es un array C (ej. IRS_ModeSelector[2]).</summary>
    public int? ArrayIndex { get; set; }

    /// <summary>bool | uchar | uint | char_array — ver ProfileEnumMapper.NativeType.</summary>
    public string? NativeType { get; set; }
}

public sealed class ControlWriteDto
{
    public string Type { get; set; } = string.Empty;

    /// <summary>Usado por la forma estándar (inputEvent/hvar/calculatorCode).</summary>
    public string Name { get; set; } = string.Empty;

    // --- Campos exclusivos de la forma clientDataEvent (SDK de terceros, ej.
    // PMDG_NG3_SDK.h, struct PMDG_NG3_Control { Event; Parameter; }). Quedan
    // vacíos/null en la forma estándar.
    /// <summary>Nombre del Client Data Area de control (ej. "PMDG_NG3_Control").</summary>
    public string? AreaName { get; set; }

    /// <summary>
    /// Valor numérico o nombre simbólico del campo Event del struct de control.
    /// Se deserializa como string aunque el YAML lo escriba como entero (YamlDotNet
    /// preserva el valor escalar) porque el schema permite integer|string y PMDG
    /// no publica una tabla completa de IDs — ver PmdgClientDataClient.ResolveEventId.
    /// </summary>
    public string? Event { get; set; }

    /// <summary>Valor o referencia opcional para el campo Parameter del struct de control.</summary>
    public string? Parameter { get; set; }

    /// <summary>
    /// OBLIGATORIO en la forma clientDataEvent (validado por
    /// tools/validate_profiles.py, no por este DTO). Descripción auditable de
    /// qué hace el Event, para mantener la regla anti-TOGGLE aunque cada Event
    /// ID de PMDG ya sea determinístico.
    /// </summary>
    public string? Semantics { get; set; }
}

public sealed class ControlSyncDto
{
    public string Mode { get; set; } = string.Empty;
    public int DebounceMs { get; set; }
    public bool ConfirmAfterWrite { get; set; }
    public int TimeoutMs { get; set; }
}

public sealed class ControlYamlDto
{
    public string Id { get; set; } = string.Empty;
    public string DataType { get; set; } = string.Empty;
    public string Authority { get; set; } = string.Empty;

    /// <summary>
    /// Opcional (default "standardSimConnect" si se omite, ver ProfileEnumMapper.SdkTier).
    /// "clientDataArea" declara que el control requiere el SDK de un addon de
    /// terceros (ej. PMDG_NG3_SDK.h) con EnableDataBroadcast=1 activo.
    /// </summary>
    public string? SdkTier { get; set; }

    /// <summary>
    /// Marca explícita de solo-lectura (ver packages/profile-schema/control.schema.json
    /// "readOnly"). Debe ser true si y solo si el YAML no declara 'write'.
    /// </summary>
    public bool ReadOnly { get; set; }

    /// <summary>
    /// Marca explícita de solo-escritura (ver packages/profile-schema/control.schema.json
    /// "writeOnly"). Debe ser true si y solo si el YAML no declara 'read' (ej. los
    /// 140 botones momentáneos del CDU/MCDU en controls/mcdu.yaml).
    /// </summary>
    public bool WriteOnly { get; set; }

    /// <summary>
    /// OPCIONAL desde que el esquema soporta 'writeOnly: true' sin 'read' (ver
    /// control.schema.json). Null cuando el control no declara bloque 'read' en
    /// el YAML — en ese caso WriteOnly debe ser true.
    /// </summary>
    public ControlReadDto? Read { get; set; }

    /// <summary>
    /// OPCIONAL desde que el esquema soporta 'readOnly: true' sin 'write' (ver
    /// control.schema.json). Null cuando el control no declara bloque 'write' en
    /// el YAML — en ese caso ReadOnly debe ser true.
    /// </summary>
    public ControlWriteDto? Write { get; set; }

    public ControlSyncDto Synchronization { get; set; } = new();
}

public sealed class MappingOverrideDto
{
    public string ControlId { get; set; } = string.Empty;
    public ControlReadDto? Read { get; set; }
    public ControlWriteDto? Write { get; set; }
}

public sealed class MappingYamlDto
{
    public List<MappingOverrideDto> Overrides { get; set; } = new();
}

public sealed class ScreenCellYamlDto
{
    public string CharField { get; set; } = string.Empty;
    public string ColorField { get; set; } = string.Empty;
    public string FlagsField { get; set; } = string.Empty;
    public int ColorValues { get; set; }
}

public sealed class ScreenYamlDto
{
    public string Id { get; set; } = string.Empty;
    public string AreaName { get; set; } = string.Empty;
    public int Rows { get; set; }
    public int Cols { get; set; }
    public string SdkTier { get; set; } = string.Empty;
    public bool ReadOnly { get; set; }
    public string? PoweredField { get; set; }
    public ScreenCellYamlDto Cell { get; set; } = new();
}
