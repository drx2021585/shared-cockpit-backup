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
                target.Read = new ControlReadDefinition
                {
                    Type = ProfileEnumMapper.ReadType(over.Read.Type),
                    Name = over.Read.Name,
                };
            }

            if (over.Write is not null)
            {
                target.Write = new ControlWriteDefinition
                {
                    Type = ProfileEnumMapper.WriteType(over.Write.Type),
                    Name = over.Write.Name,
                };
            }
        }
    }

    private static ControlDefinition ToControlDefinition(ControlYamlDto dto) => new()
    {
        Id = dto.Id,
        DataType = ProfileEnumMapper.DataType(dto.DataType),
        Authority = ProfileEnumMapper.Authority(dto.Authority),
        Read = new ControlReadDefinition
        {
            Type = ProfileEnumMapper.ReadType(dto.Read.Type),
            Name = dto.Read.Name,
        },
        Write = new ControlWriteDefinition
        {
            Type = ProfileEnumMapper.WriteType(dto.Write.Type),
            Name = dto.Write.Name,
        },
        Synchronization = new ControlSynchronization
        {
            Mode = ProfileEnumMapper.SyncMode(dto.Synchronization.Mode),
            DebounceMs = dto.Synchronization.DebounceMs,
            ConfirmAfterWrite = dto.Synchronization.ConfirmAfterWrite,
            TimeoutMs = dto.Synchronization.TimeoutMs,
        },
    };

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
