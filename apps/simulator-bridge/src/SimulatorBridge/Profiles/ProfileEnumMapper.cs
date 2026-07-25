namespace SharedCockpit.Bridge.Profiles;

/// <summary>Mapeo explícito string YAML -> enum tipado. Lanza si aparece un valor no contemplado
/// por packages/profile-schema (mejor fallar ruidosamente que adivinar).</summary>
public static class ProfileEnumMapper
{
    public static ControlDataType DataType(string value) => value switch
    {
        "boolean" => ControlDataType.Boolean,
        "number" => ControlDataType.Number,
        "string" => ControlDataType.String,
        _ => throw new NotSupportedException($"dataType desconocido en perfil: '{value}'"),
    };

    public static ControlAuthority Authority(string value) => value switch
    {
        "exclusive" => ControlAuthority.Exclusive,
        "shared" => ControlAuthority.Shared,
        "captain-only" => ControlAuthority.CaptainOnly,
        "first-officer-only" => ControlAuthority.FirstOfficerOnly,
        "instructor-only" => ControlAuthority.InstructorOnly,
        "local-only" => ControlAuthority.LocalOnly,
        _ => throw new NotSupportedException($"authority desconocida en perfil: '{value}'"),
    };

    public static ReadType ReadType(string value) => value switch
    {
        "simvar" => Profiles.ReadType.Simvar,
        "lvar" => Profiles.ReadType.Lvar,
        "hvar" => Profiles.ReadType.Hvar,
        _ => throw new NotSupportedException($"read.type desconocido en perfil: '{value}'"),
    };

    public static WriteType WriteType(string value) => value switch
    {
        "inputEvent" => Profiles.WriteType.InputEvent,
        "hvar" => Profiles.WriteType.Hvar,
        "calculatorCode" => Profiles.WriteType.CalculatorCode,
        _ => throw new NotSupportedException($"write.type desconocido en perfil: '{value}'"),
    };

    public static SyncMode SyncMode(string value) => value switch
    {
        "event" => Profiles.SyncMode.Event,
        "polled" => Profiles.SyncMode.Polled,
        _ => throw new NotSupportedException($"synchronization.mode desconocido en perfil: '{value}'"),
    };
}
