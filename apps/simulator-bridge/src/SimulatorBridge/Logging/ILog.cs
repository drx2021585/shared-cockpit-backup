namespace SharedCockpit.Bridge.Logging;

public interface ILog
{
    void Info(string message);
    void Warn(string message);
    void Error(string message);
    void Debug(string message);
}

/// <summary>
/// Logging estructurado a stdout. Sprint 1 corre como proceso plano (sin
/// instalador/UI todavía), así que stdout es la única salida — connect/
/// disconnect, perfil detectado, y errores de lectura/escritura deben quedar
/// visibles ahí para que el diagnóstico de la UI (o el operador) los vea.
/// </summary>
public sealed class ConsoleLog : ILog
{
    private static void Write(string level, string message)
    {
        var timestamp = DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
        Console.WriteLine($"[{timestamp}] [{level}] {message}");
    }

    public void Info(string message) => Write("INFO", message);
    public void Warn(string message) => Write("WARN", message);
    public void Error(string message) => Write("ERROR", message);
    public void Debug(string message) => Write("DEBUG", message);
}
