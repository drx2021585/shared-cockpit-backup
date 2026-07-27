using SharedCockpit.Bridge.Logging;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace SharedCockpit.Bridge.Profiles;

public enum SimulatorVersion
{
    Msfs2020,
    Msfs2024,
}

/// <summary>
/// Carga aircraft-profiles/&lt;id&gt;/ desde disco. El bridge es CONSUMIDOR de este
/// contenido (ver README.md raíz y CLAUDE.md): nunca escribe ni valida el
/// esquema aquí, solo lo interpreta. La validación formal del esquema vive en
/// tools/validate_profiles.py (aircraft-profiles-agent / orquestador).
/// </summary>
public sealed class ProfileRepository
{
    private readonly string _aircraftProfilesRoot;
    private readonly IDeserializer _deserializer;

    public ProfileRepository(string aircraftProfilesRoot)
    {
        _aircraftProfilesRoot = aircraftProfilesRoot;
        _deserializer = new DeserializerBuilder()
            .WithNamingConvention(CamelCaseNamingConvention.Instance)
            .IgnoreUnmatchedProperties()
            .Build();
    }

    /// <summary>
    /// Busca aircraft-profiles/ subiendo desde el directorio del ejecutable. En
    /// Sprint 1 el bridge corre desde el monorepo (bin/Debug/... dentro de
    /// apps/simulator-bridge), así que subir directorios hasta encontrar la
    /// carpeta hermana funciona tanto en desarrollo como en un build local.
    /// Si no se encuentra, se debe pasar la ruta explícitamente (ver Program.cs
    /// / variable de entorno SHAREDCOCKPIT_PROFILES_DIR).
    /// </summary>
    public static string? DiscoverRoot(string startDirectory)
    {
        var dir = new DirectoryInfo(startDirectory);
        for (var i = 0; i < 12 && dir is not null; i++, dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "aircraft-profiles");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }
        }

        return null;
    }

    public IReadOnlyList<string> ListProfileIds()
    {
        if (!Directory.Exists(_aircraftProfilesRoot))
        {
            return Array.Empty<string>();
        }

        return Directory.GetDirectories(_aircraftProfilesRoot)
            .Select(Path.GetFileName)
            .Where(name => !string.IsNullOrEmpty(name))
            .Select(name => name!)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();
    }

    public IReadOnlyList<AircraftProfile> LoadAll(SimulatorVersion simVersion, ILog log)
    {
        var profiles = new List<AircraftProfile>();
        foreach (var id in ListProfileIds())
        {
            try
            {
                profiles.Add(LoadOne(id, simVersion));
            }
            catch (Exception ex)
            {
                log.Error($"No se pudo cargar el perfil '{id}': {ex.Message}");
            }
        }

        return profiles;
    }

    public AircraftProfile LoadOne(string profileId, SimulatorVersion simVersion)
    {
        var dir = Path.Combine(_aircraftProfilesRoot, profileId);
        if (!Directory.Exists(dir))
        {
            throw new DirectoryNotFoundException($"Perfil '{profileId}' no existe en {_aircraftProfilesRoot}");
        }

        var manifestDto = Deserialize<ManifestYamlDto>(Path.Combine(dir, "manifest.yaml"));
        var detectionDto = Deserialize<DetectionYamlDto>(Path.Combine(dir, "detection.yaml"));

        var manifest = new AircraftManifest
        {
            SchemaVersion = manifestDto.SchemaVersion,
            Aircraft = new AircraftInfo
            {
                Id = manifestDto.Aircraft.Id,
                Name = manifestDto.Aircraft.Name,
                Developer = manifestDto.Aircraft.Developer,
            },
            Compatibility = new CompatibilityInfo
            {
                Msfs2020 = manifestDto.Compatibility.Msfs2020,
                Msfs2024 = manifestDto.Compatibility.Msfs2024,
            },
        };

        var detection = new DetectionRule
        {
            TitleContains = detectionDto.TitleContains,
            FallbackToPartialMatch = detectionDto.FallbackToPartialMatch,
        };

        var controlsDir = Path.Combine(dir, "controls");
        var controls = new List<ControlDefinition>();
        if (Directory.Exists(controlsDir))
        {
            foreach (var file in Directory.GetFiles(controlsDir, "*.yaml").OrderBy(f => f, StringComparer.Ordinal))
            {
                var dtoList = Deserialize<List<ControlYamlDto>>(file) ?? new List<ControlYamlDto>();
                foreach (var dto in dtoList)
                {
                    controls.Add(ToControlDefinition(dto));
                }
            }
        }

        ApplyMappingOverrides(dir, simVersion, controls);

        return new AircraftProfile
        {
            ProfileId = profileId,
            Manifest = manifest,
            Detection = detection,
            Controls = controls,
        };
    }

    private void ApplyMappingOverrides(string profileDir, SimulatorVersion simVersion, List<ControlDefinition> controls)
    {
        var mappingFileName = simVersion == SimulatorVersion.Msfs2020 ? "msfs2020.yaml" : "msfs2024.yaml";
        var mappingPath = Path.Combine(profileDir, "mappings", mappingFileName);
        if (!File.Exists(mappingPath))
        {
            return;
        }

        var mapping = Deserialize<MappingYamlDto>(mappingPath);
        if (mapping.Overrides.Count == 0)
        {
            return;
        }

        foreach (var over in mapping.Overrides)
        {
            var target = controls.FirstOrDefault(c => c.Id == over.ControlId);
            if (target is null)
            {
                continue;
            }

            if (over.Read is not null)
            {
                target.Read = ToReadDefinition(over.Read);
            }

            if (over.Write is not null)
            {
                target.Write = ToWriteDefinition(over.Write);
            }
        }
    }

    private static ControlDefinition ToControlDefinition(ControlYamlDto dto) => new()
    {
        Id = dto.Id,
        DataType = ProfileEnumMapper.DataType(dto.DataType),
        Authority = ProfileEnumMapper.Authority(dto.Authority),
        SdkTier = ProfileEnumMapper.SdkTier(dto.SdkTier),
        ReadOnly = dto.ReadOnly,
        WriteOnly = dto.WriteOnly,
        // dto.Read es null cuando el control declara writeOnly: true sin bloque
        // 'read' (ej. los 140 botones momentáneos del CDU en controls/mcdu.yaml).
        // No hay nada que convertir en ese caso -- el bridge nunca debe intentar
        // suscribir/leerlo (ver BridgeService.SubscribeControls).
        Read = dto.Read is null ? null : ToReadDefinition(dto.Read),
        // dto.Write es null cuando el control declara readOnly: true sin bloque
        // 'write' (ver control.schema.json). No hay nada que convertir en ese
        // caso -- el bridge nunca debe intentar escribirlo (ver BridgeService).
        Write = dto.Write is null ? null : ToWriteDefinition(dto.Write),
        Synchronization = new ControlSynchronization
        {
            Mode = ProfileEnumMapper.SyncMode(dto.Synchronization.Mode),
            DebounceMs = dto.Synchronization.DebounceMs,
            ConfirmAfterWrite = dto.Synchronization.ConfirmAfterWrite,
            TimeoutMs = dto.Synchronization.TimeoutMs,
        },
    };

    /// <summary>
    /// Convierte la forma cruda del YAML a ControlReadDefinition, cubriendo tanto la
    /// forma estándar (simvar/lvar/hvar + name) como clientDataArea (areaName/field/
    /// arrayIndex/nativeType). Perfiles existentes sin los campos nuevos siguen
    /// deserializando exactamente igual que antes (los campos nuevos quedan null).
    /// </summary>
    private static ControlReadDefinition ToReadDefinition(ControlReadDto dto)
    {
        var type = ProfileEnumMapper.ReadType(dto.Type);
        if (type == ReadType.ClientDataArea)
        {
            return new ControlReadDefinition
            {
                Type = type,
                AreaName = dto.AreaName,
                Field = dto.Field,
                ArrayIndex = dto.ArrayIndex,
                NativeType = dto.NativeType is null ? null : ProfileEnumMapper.NativeType(dto.NativeType),
            };
        }

        return new ControlReadDefinition
        {
            Type = type,
            Name = dto.Name,
        };
    }

    /// <summary>
    /// Convierte la forma cruda del YAML a ControlWriteDefinition, cubriendo tanto la
    /// forma estándar (inputEvent/hvar/calculatorCode + name) como clientDataEvent
    /// (areaName/event/parameter/semantics).
    /// </summary>
    private static ControlWriteDefinition ToWriteDefinition(ControlWriteDto dto)
    {
        var type = ProfileEnumMapper.WriteType(dto.Type);
        if (type == WriteType.ClientDataEvent)
        {
            return new ControlWriteDefinition
            {
                Type = type,
                AreaName = dto.AreaName,
                Event = dto.Event,
                Parameter = dto.Parameter,
                Semantics = dto.Semantics,
            };
        }

        if (type == WriteType.NativeEventValue)
        {
            return new ControlWriteDefinition
            {
                Type = type,
                Name = dto.Name,
                Parameter = dto.Parameter,
                Semantics = dto.Semantics,
            };
        }

        return new ControlWriteDefinition
        {
            Type = type,
            Name = dto.Name,
        };
    }

    private T Deserialize<T>(string path) where T : new()
    {
        if (!File.Exists(path))
        {
            return new T();
        }

        using var reader = new StreamReader(path);
        return _deserializer.Deserialize<T>(reader) ?? new T();
    }
}
