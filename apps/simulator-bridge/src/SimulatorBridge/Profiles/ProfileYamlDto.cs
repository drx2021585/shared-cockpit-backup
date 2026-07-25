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
    public string Name { get; set; } = string.Empty;
}

public sealed class ControlWriteDto
{
    public string Type { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
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
    public ControlReadDto Read { get; set; } = new();
    public ControlWriteDto Write { get; set; } = new();
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
