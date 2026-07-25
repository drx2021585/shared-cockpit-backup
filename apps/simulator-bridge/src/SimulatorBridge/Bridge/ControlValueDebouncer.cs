namespace SharedCockpit.Bridge.Bridge;

/// <summary>
/// Aplica synchronization.debounceMs por control antes de emitir un
/// control.event hacia el WebSocket local. Comportamiento "trailing edge":
/// si el valor cambia, se emite de inmediato salvo que ya se haya emitido
/// algo para esa key hace menos de debounceMs, en cuyo caso se agenda un
/// reenvío único con el valor más reciente al cumplirse la ventana (para no
/// perder el estado final si el usuario/el sim generan varios cambios
/// seguidos, ej. un interruptor "ruidoso").
/// control.axis (canal rápido) NO pasa por este debouncer: ahí "último valor
/// gana" es el comportamiento correcto por definición de canal rápido.
/// </summary>
public sealed class ControlValueDebouncer : IDisposable
{
    private sealed class Entry
    {
        public object? LastEmittedValue;
        public DateTime LastEmittedAt = DateTime.MinValue;
        public Timer? PendingTimer;
        public object? PendingValue;
    }

    private readonly Dictionary<string, Entry> _entries = new();
    private readonly object _lock = new();

    /// <summary>Devuelve true si se debe emitir YA. Si devuelve false, ya se agendó (o descartó) un reenvío diferido.</summary>
    public bool ShouldEmitNow(string key, object value, int debounceMs, Action<object> emitLater)
    {
        lock (_lock)
        {
            if (!_entries.TryGetValue(key, out var entry))
            {
                entry = new Entry();
                _entries[key] = entry;
            }

            if (Equals(entry.LastEmittedValue, value))
            {
                return false;
            }

            var elapsed = (DateTime.UtcNow - entry.LastEmittedAt).TotalMilliseconds;
            if (debounceMs <= 0 || elapsed >= debounceMs)
            {
                entry.LastEmittedValue = value;
                entry.LastEmittedAt = DateTime.UtcNow;
                entry.PendingTimer?.Dispose();
                entry.PendingTimer = null;
                return true;
            }

            entry.PendingValue = value;
            entry.PendingTimer?.Dispose();
            var remaining = Math.Max(1, debounceMs - (int)elapsed);
            entry.PendingTimer = new Timer(_ =>
            {
                lock (_lock)
                {
                    if (!_entries.TryGetValue(key, out var e) || e.PendingValue is null)
                    {
                        return;
                    }

                    e.LastEmittedValue = e.PendingValue;
                    e.LastEmittedAt = DateTime.UtcNow;
                    e.PendingTimer?.Dispose();
                    e.PendingTimer = null;
                    var toEmit = e.PendingValue;
                    e.PendingValue = null;
                    if (toEmit is not null)
                    {
                        emitLater(toEmit);
                    }
                }
            }, null, remaining, Timeout.Infinite);

            return false;
        }
    }

    public void Dispose()
    {
        lock (_lock)
        {
            foreach (var entry in _entries.Values)
            {
                entry.PendingTimer?.Dispose();
            }

            _entries.Clear();
        }
    }
}
