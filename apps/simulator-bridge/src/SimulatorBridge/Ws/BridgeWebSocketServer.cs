using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using SharedCockpit.Bridge.Logging;
using SharedCockpit.Bridge.Protocol;

namespace SharedCockpit.Bridge.Ws;

/// <summary>
/// Servidor WebSocket local en ws://localhost:7620 (puerto fijado por
/// docs/decisiones/web-first.md). Usa HttpListener (incluido en .NET, sin
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
    private readonly List<WebSocket> _clients = new();
    private readonly object _clientsLock = new();
    private CancellationTokenSource? _cts;
    private Task? _acceptLoopTask;

    public BridgeWebSocketServer(int port, ILog log, Action<IncomingMessage> onIncoming)
    {
        _log = log;
        _onIncoming = onIncoming;
        _listener.Prefixes.Add($"http://localhost:{port}/");
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

        lock (_clientsLock)
        {
            _clients.Add(socket);
        }

        _log.Info("Cliente conectado al bridge por WebSocket.");

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

            socket.Dispose();
            _log.Info("Cliente WebSocket desconectado.");
        }
    }

    private static string Truncate(string s) => s.Length > 200 ? s[..200] + "..." : s;

    public void Broadcast(JsonObject message)
    {
        var json = message.ToJsonString();
        var bytes = Encoding.UTF8.GetBytes(json);

        List<WebSocket> snapshot;
        lock (_clientsLock)
        {
            snapshot = new List<WebSocket>(_clients);
        }

        foreach (var client in snapshot)
        {
            if (client.State != WebSocketState.Open)
            {
                continue;
            }

            _ = SendSafeAsync(client, bytes);
        }
    }

    private async Task SendSafeAsync(WebSocket client, byte[] bytes)
    {
        try
        {
            await client.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, endOfMessage: true, CancellationToken.None);
        }
        catch (Exception ex)
        {
            _log.Warn($"No se pudo enviar mensaje a un cliente WebSocket: {ex.Message}");
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
            foreach (var client in _clients)
            {
                client.Dispose();
            }

            _clients.Clear();
        }

        _listener.Close();
    }
}
