using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using SharedCockpit.Bridge.Logging;
using SharedCockpit.Bridge.Protocol;

namespace SharedCockpit.Bridge.Ws;

/// <summary>
/// Servidor WebSocket local en loopback (configurable; default 127.0.0.1:17481).
/// Usa HttpListener (incluido en .NET, sin
/// dependencias externas de framework web) porque este proceso es un
/// worker/consola simple, no una API HTTP completa.
///
/// Reenvía cada mensaje entrante a través de IncomingMessageParser y del
/// callback OnIncoming (normalmente BridgeService.HandleIncoming) y difunde
/// (broadcast) cada JsonObject producido por el bridge a TODOS los clientes
/// conectados (típicamente un único proceso de apps/desktop-ui en Sprint 1,
/// pero no se asume eso).
/// </summary>
public sealed class BridgeWebSocketServer : IAsyncDisposable
{
    private readonly HttpListener _listener = new();
    private readonly ILog _log;
    private readonly Action<IncomingMessage> _onIncoming;
    // .NET WebSocket solo permite un SendAsync pendiente a la vez por instancia -- con
    // Broadcast() disparando fire-and-forget por cada mensaje (incluido el canal rápido
    // de control.axis a 20-60Hz), dos envíos concurrentes al mismo cliente abortaban la
    // conexión ("There is already one outstanding 'SendAsync' call..."). Un semáforo por
    // cliente serializa los envíos sin bloquear a los demás clientes conectados.
    private readonly Dictionary<WebSocket, SemaphoreSlim> _clients = new();
    private readonly object _clientsLock = new();
    private byte[]? _lastStatusBytes;
    private CancellationTokenSource? _cts;
    private Task? _acceptLoopTask;
    private readonly HashSet<string> _allowedOrigins;
    // Token efímero opcional (SHAREDCOCKPIT_BRIDGE_TOKEN): cuando We Connect
    // lanza este proceso, genera un secreto y lo exige como ?token= en el
    // handshake — así ningún otro proceso local puede inyectar comandos al
    // simulador. null = lanzado a mano sin token (flujo de desarrollo), se
    // acepta cualquier cliente local como antes.
    private readonly string? _authToken;

    public BridgeWebSocketServer(string host, int port, IEnumerable<string> allowedOrigins, ILog log, Action<IncomingMessage> onIncoming, string? authToken = null)
    {
        _log = log;
        _onIncoming = onIncoming;
        _authToken = string.IsNullOrEmpty(authToken) ? null : authToken;
        _allowedOrigins = new HashSet<string>(allowedOrigins, StringComparer.OrdinalIgnoreCase);
        _listener.Prefixes.Add($"http://{host}:{port}/");
    }

    /// <summary>
    /// Defensa contra páginas web maliciosas: un navegador cualquiera puede
    /// abrir un WebSocket a ws://localhost:7620 desde cualquier sitio https
    /// (el mismo-origen no aplica a WebSocket), pero SIEMPRE manda la
    /// cabecera Origin. Se aceptan solo orígenes de la propia app: file://
    /// (Electron empaquetado), http://localhost / 127.0.0.1 (Vite dev) o
    /// ausencia de Origin (clientes no-navegador, p.ej. herramientas locales).
    /// </summary>
    private bool IsOriginAllowed(string? origin)
    {
        if (string.IsNullOrEmpty(origin)) return true;
        return origin.StartsWith("file://", StringComparison.OrdinalIgnoreCase)
            || origin.Equals("null", StringComparison.OrdinalIgnoreCase)
            || _allowedOrigins.Any(allowed => origin.StartsWith(allowed, StringComparison.OrdinalIgnoreCase));
    }

    private bool IsAuthorized(HttpListenerContext context)
    {
        if (_authToken is null) return true;
        var provided = context.Request.QueryString["token"];
        if (string.IsNullOrEmpty(provided)) return false;
        var expected = Encoding.UTF8.GetBytes(_authToken);
        var actual = Encoding.UTF8.GetBytes(provided);
        return expected.Length == actual.Length && CryptographicOperations.FixedTimeEquals(expected, actual);
    }

    public void Start()
    {
        _cts = new CancellationTokenSource();
        _listener.Start();
        _log.Info($"WebSocket local escuchando en {string.Join(", ", _listener.Prefixes)}");
        _acceptLoopTask = AcceptLoopAsync(_cts.Token);
    }

    private async Task AcceptLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            HttpListenerContext context;
            try
            {
                context = await _listener.GetContextAsync().WaitAsync(ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (HttpListenerException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _log.Error($"Error aceptando conexión WebSocket: {ex.Message}");
                continue;
            }

            if (!context.Request.IsWebSocketRequest)
            {
                context.Response.StatusCode = 400;
                context.Response.Close();
                continue;
            }

            var origin = context.Request.Headers["Origin"];
            if (!IsOriginAllowed(origin))
            {
                _log.Warn($"Conexión WebSocket rechazada por Origin no permitido: {origin}");
                context.Response.StatusCode = 403;
                context.Response.Close();
                continue;
            }

            if (!IsAuthorized(context))
            {
                _log.Warn("Conexión WebSocket rechazada: token del bridge ausente o inválido.");
                context.Response.StatusCode = 401;
                context.Response.Close();
                continue;
            }

            _ = HandleClientAsync(context, ct);
        }
    }

    private async Task HandleClientAsync(HttpListenerContext context, CancellationToken ct)
    {
        WebSocket socket;
        try
        {
            var wsContext = await context.AcceptWebSocketAsync(subProtocol: null);
            socket = wsContext.WebSocket;
        }
        catch (Exception ex)
        {
            _log.Error($"Fallo al aceptar handshake WebSocket: {ex.Message}");
            return;
        }

        var sendGate = new SemaphoreSlim(1, 1);
        lock (_clientsLock)
        {
            _clients.Add(socket, sendGate);
        }

        _log.Info("Cliente conectado al bridge por WebSocket.");
        byte[]? lastStatus;
        lock (_clientsLock)
        {
            lastStatus = _lastStatusBytes;
        }
        if (lastStatus is not null)
        {
            await SendSafeAsync(socket, sendGate, lastStatus);
        }

        var buffer = new byte[16 * 1024];
        try
        {
            while (socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                var result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", ct);
                    break;
                }

                var json = Encoding.UTF8.GetString(buffer, 0, result.Count);
                var parsed = IncomingMessageParser.TryParse(json);
                if (parsed is null)
                {
                    _log.Warn($"Mensaje WebSocket entrante no reconocido, se ignora: {Truncate(json)}");
                    continue;
                }

                try
                {
                    _onIncoming(parsed);
                }
                catch (Exception ex)
                {
                    _log.Error($"Error procesando mensaje entrante: {ex.Message}");
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Cierre normal del servidor.
        }
        catch (Exception ex)
        {
            _log.Warn($"Conexión WebSocket cerrada de forma anómala: {ex.Message}");
        }
        finally
        {
            lock (_clientsLock)
            {
                _clients.Remove(socket);
            }

            sendGate.Dispose();
            socket.Dispose();
            _log.Info("Cliente WebSocket desconectado.");
        }
    }

    private static string Truncate(string s) => s.Length > 200 ? s[..200] + "..." : s;

    public void Broadcast(JsonObject message)
    {
        var json = message.ToJsonString();
        var bytes = Encoding.UTF8.GetBytes(json);

        List<KeyValuePair<WebSocket, SemaphoreSlim>> snapshot;
        lock (_clientsLock)
        {
            if (message["type"]?.GetValue<string>() == "bridge.status")
            {
                _lastStatusBytes = bytes;
            }
            snapshot = new List<KeyValuePair<WebSocket, SemaphoreSlim>>(_clients);
        }

        foreach (var (client, sendGate) in snapshot)
        {
            if (client.State != WebSocketState.Open)
            {
                continue;
            }

            _ = SendSafeAsync(client, sendGate, bytes);
        }
    }

    private async Task SendSafeAsync(WebSocket client, SemaphoreSlim sendGate, byte[] bytes)
    {
        await sendGate.WaitAsync();
        try
        {
            if (client.State != WebSocketState.Open)
            {
                return;
            }

            await client.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, endOfMessage: true, CancellationToken.None);
        }
        catch (Exception ex)
        {
            _log.Warn($"No se pudo enviar mensaje a un cliente WebSocket: {ex.Message}");
        }
        finally
        {
            sendGate.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        _cts?.Cancel();
        _listener.Stop();

        if (_acceptLoopTask is not null)
        {
            try
            {
                await _acceptLoopTask;
            }
            catch
            {
                // ignorar excepciones de cancelación durante el apagado
            }
        }

        lock (_clientsLock)
        {
            foreach (var (client, sendGate) in _clients)
            {
                client.Dispose();
                sendGate.Dispose();
            }

            _clients.Clear();
        }

        _listener.Close();
    }
}
