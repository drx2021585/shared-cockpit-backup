using System.Text.Json;
using System.Text.RegularExpressions;

namespace SharedCockpit.Bridge.Bridge;

/// <summary>
/// ====================================================================================
/// Calibración de polaridad APRENDIDA EN VIVO para controles posicionales.
///
/// EL PROBLEMA
/// -----------
/// Los selectores del iFly 737 MAX 8 no aceptan un SET absoluto: cada escritura
/// avanza UN paso, y la dirección la decide el RPN del perfil comparando el
/// estado real contra el destino. El perfil se generó mecánicamente del modelo 3D
/// asumiendo la convención de la rueda del ratón (WheelUp = subir, WheelDown =
/// bajar), pero esa convención NO se cumple universalmente: gear.autobrake_sw la
/// respeta y engine.apu_sw la tiene invertida — los dos salieron del mismo
/// generador con la misma regla. Medido en vivo el 2026-07-28/29.
///
/// Son ~340 controles posicionales y NO hay forma de saber la polaridad de cada
/// uno desde el XML del modelo. Calibrarlos a mano exige una pasada de medición
/// control por control contra MSFS.
///
/// LA SOLUCIÓN QUE IMPLEMENTA ESTA CLASE
/// -------------------------------------
/// No hace falta saber la polaridad de antemano: el bridge puede DESCUBRIRLA la
/// primera vez que use cada control. El lazo de convergencia ya detecta los dos
/// síntomas de una polaridad cruzada (el control se aleja del destino, o no se
/// mueve en absoluto porque está empujando contra su tope). Hasta ahora, al
/// detectarlos, se rendía. Con esta clase, en cambio, invierte el RPN, reintenta,
/// y RECUERDA el resultado.
///
/// Coste de un control mal calibrado: un paso perdido, una vez. Después queda
/// correcto para siempre — y la corrección se persiste, así que se acumula entre
/// sesiones en vez de re-aprenderse cada vuelo.
///
/// POR QUÉ INVERTIR EL RPN ES SEGURO
/// ---------------------------------
/// La inversión es puramente sintáctica y se aplica SOLO a la forma canónica que
/// emitió el generador (ver tools/generate_ifly_profile.py):
///
///   (L:X_VAL,number) $value &lt; if{ SUBE (&gt;L:trigger) } (L:X_VAL,number) $value &gt; if{ BAJA (&gt;L:trigger) }
///
/// Intercambiar los operadores `&lt;` y `&gt;` que van inmediatamente después de
/// `$value` equivale a intercambiar qué código se manda en cada dirección, sin
/// tocar los códigos ni la estructura.
///
/// Las otras tres formas del perfil quedan intactas porque no contienen el patrón
/// `$value &lt;` / `$value &gt;` con el operador pegado al marcador:
///
///   - Botón momentáneo:    `$value 0 &gt; if{ PULSA } els{ SUELTA }`  → hay un `0` en medio
///   - Código único:        `(L:X_VAL,number) $value != if{ CODIGO }` → operador `!=`
///   - Controles calibrados a mano (ej. engine.apu_sw, que compara por bandas:
///     `... $value 5 &gt; and if{ ... }`) → hay un número en medio
///
/// Ese último caso importa mucho: los controles ya medidos y corregidos a mano NO
/// son candidatos a inversión automática, y el discriminador los excluye solo,
/// sin necesidad de una lista de excepciones que se pudiera desincronizar.
///
/// REVERSIÓN ANTE FALLO GENUINO
/// ----------------------------
/// Un control puede fallar en converger por motivos que NO son polaridad: el
/// sistema está sin alimentación, la L-Var no existe en esa variante, el valor
/// pedido no es una detente legal. Si tras invertir SIGUE fallando, la inversión
/// se revierte y se reporta el error real. Así un fallo ajeno a la polaridad no
/// deja el perfil peor de como estaba.
/// ====================================================================================
/// </summary>
public sealed class PolarityCalibration
{
    /// <summary>
    /// Operadores de comparación INMEDIATAMENTE pegados al marcador `$value`, que es
    /// la firma de la forma posicional generada. Lo esencial es que entre el
    /// marcador y el operador no haya nada más que espacios: si hubiera un número
    /// (`$value 5 &gt;`, la forma calibrada a mano por bandas, o `$value 0 &gt;`, la de
    /// los botones momentáneos) el patrón no engancha y ese control queda excluido
    /// de la inversión automática, que es exactamente lo que se busca.
    ///
    /// `\s*` y no `\s+`: el generador siempre pone un espacio, pero un RPN escrito
    /// a mano como `$value&lt; if{...}` sigue siendo la misma forma y no tiene por qué
    /// quedar fuera.
    /// </summary>
    private static readonly Regex LessThanAfterValue = new(@"(\$value\s*)<", RegexOptions.Compiled);
    private static readonly Regex GreaterThanAfterValue = new(@"(\$value\s*)>", RegexOptions.Compiled);

    /// <summary>
    /// Marcador temporal para el intercambio en tres pasos. No puede aparecer en
    /// un RPN real (no es un token válido de calculator code).
    /// </summary>
    private const string SwapSentinel = "SWAP";

    private readonly string? _persistPath;
    private readonly HashSet<string> _inverted = new(StringComparer.Ordinal);

    /// <summary>
    /// HandleIncoming corre en el hilo del WebSocket y el lazo de confirmación en
    /// el del pump; los dos pueden llegar a MarkInverted/RevertInversion. Sin este
    /// candado, dos File.WriteAllText concurrentes sobre el mismo archivo se pisan
    /// (y el HashSet se corrompe silenciosamente al mutarse desde dos hilos).
    /// </summary>
    private readonly object _gate = new();

    /// <summary>
    /// RPN invertido ya calculado, indexado por el RPN original. Evita repetir las
    /// tres pasadas de regex en cada escritura de un control ya calibrado.
    /// </summary>
    private static readonly Dictionary<string, string?> InvertedCache = new(StringComparer.Ordinal);
    private static readonly object CacheGate = new();

    /// <summary>
    /// Controles cuya inversión ya se probó y NO arregló nada. Se recuerdan para
    /// no volver a invertirlos en bucle durante la misma sesión: sin esto, cada
    /// escritura fallida por un motivo ajeno a la polaridad gastaría un ciclo
    /// extra de inversión + reintento.
    /// </summary>
    private readonly HashSet<string> _inversionRuledOut = new(StringComparer.Ordinal);

    /// <param name="persistPath">
    /// Ruta del JSON donde acumular lo aprendido. Null = solo en memoria, que es
    /// lo que usan los tests (no tocan disco).
    /// </param>
    public PolarityCalibration(string? persistPath = null)
    {
        _persistPath = persistPath;
        Load();
    }

    /// <summary>
    /// ¿Este RPN es la forma posicional generada, con dirección invertible? Es la
    /// precondición de todo lo demás: un control cuyo RPN no sea invertible nunca
    /// se marca ni se reintenta, se reporta el fallo tal cual.
    /// </summary>
    public static bool CanInvert(string? rpn) =>
        rpn is not null
        && LessThanAfterValue.IsMatch(rpn)
        && GreaterThanAfterValue.IsMatch(rpn);

    /// <summary>
    /// Intercambia `&lt;` y `&gt;` pegados a `$value`, invirtiendo la dirección del
    /// control sin tocar los códigos de comando ni la estructura del RPN.
    /// Devuelve null si el RPN no es de la forma posicional invertible.
    /// </summary>
    public static string? Invert(string? rpn)
    {
        if (rpn is null)
        {
            return null;
        }

        lock (CacheGate)
        {
            if (InvertedCache.TryGetValue(rpn, out var cached))
            {
                return cached;
            }
        }

        var result = InvertUncached(rpn);

        lock (CacheGate)
        {
            InvertedCache[rpn] = result;
        }

        return result;
    }

    private static string? InvertUncached(string rpn)
    {
        if (!CanInvert(rpn))
        {
            return null;
        }

        // Tres pasos con centinela para no re-intercambiar lo ya intercambiado.
        var swapped = LessThanAfterValue.Replace(rpn, "$1" + SwapSentinel);
        swapped = GreaterThanAfterValue.Replace(swapped, "$1<");
        return swapped.Replace(SwapSentinel, ">", StringComparison.Ordinal);
    }

    /// <summary>
    /// ¿Se aprendió que este control tiene la polaridad al revés de lo que dice
    /// el perfil? Si sí, el bridge debe ejecutar el RPN invertido.
    /// </summary>
    public bool IsInverted(string profileId, string controlId)
    {
        lock (_gate)
        {
            return _inverted.Contains(Key(profileId, controlId));
        }
    }

    /// <summary>
    /// ¿Vale la pena intentar invertir este control ahora mismo? Falso si ya está
    /// invertido (ya se probó esa dirección), si ya se descartó la inversión como
    /// causa, o si el RPN no es de la forma invertible.
    /// </summary>
    public bool ShouldTryInverting(string profileId, string controlId, string? rpn)
    {
        if (!CanInvert(rpn))
        {
            return false;
        }

        var key = Key(profileId, controlId);
        lock (_gate)
        {
            return !_inverted.Contains(key) && !_inversionRuledOut.Contains(key);
        }
    }

    /// <summary>
    /// Registra que este control necesita la polaridad invertida, y lo persiste.
    /// </summary>
    public void MarkInverted(string profileId, string controlId)
    {
        lock (_gate)
        {
            if (_inverted.Add(Key(profileId, controlId)))
            {
                SaveLocked();
            }
        }
    }

    /// <summary>
    /// Deshace una inversión que no arregló el problema: la causa del fallo era
    /// otra, y dejarla puesta empeoraría el control la próxima vez. Se recuerda
    /// como "descartada" para no reintentarla en bucle.
    /// </summary>
    public void RevertInversion(string profileId, string controlId)
    {
        var key = Key(profileId, controlId);
        lock (_gate)
        {
            _inversionRuledOut.Add(key);
            if (_inverted.Remove(key))
            {
                SaveLocked();
            }
        }
    }

    /// <summary>
    /// Controles aprendidos hasta ahora, para poder reportarlos (y para que la
    /// pasada de calibración pueda volcarlos a los YAML del perfil de forma
    /// permanente en vez de depender del JSON).
    /// </summary>
    public IReadOnlyCollection<string> InvertedKeys
    {
        get
        {
            lock (_gate)
            {
                return _inverted.ToArray();
            }
        }
    }

    private static string Key(string profileId, string controlId) => $"{profileId}:{controlId}";

    private void Load()
    {
        if (_persistPath is null || !File.Exists(_persistPath))
        {
            return;
        }

        try
        {
            var json = File.ReadAllText(_persistPath);
            var keys = JsonSerializer.Deserialize<string[]>(json);
            if (keys is null)
            {
                return;
            }

            foreach (var key in keys)
            {
                _inverted.Add(key);
            }
        }
        catch
        {
            // Un JSON corrupto o ilegible NO puede impedir que el bridge arranque:
            // lo aprendido es una optimización, no un requisito. Se re-aprende.
        }
    }

    /// <summary>
    /// Llamar SIEMPRE con _gate tomado. Escribe a un temporal y lo mueve encima del
    /// definitivo: si el proceso muere a mitad de la escritura, el archivo viejo
    /// queda intacto en vez de truncado. Load() tolera un JSON corrupto, pero
    /// tolerarlo significa perder toda la calibración aprendida — mejor no
    /// producirlo.
    /// </summary>
    private void SaveLocked()
    {
        if (_persistPath is null)
        {
            return;
        }

        try
        {
            var dir = Path.GetDirectoryName(_persistPath);
            if (!string.IsNullOrEmpty(dir))
            {
                Directory.CreateDirectory(dir);
            }

            var json = JsonSerializer.Serialize(
                _inverted.OrderBy(k => k, StringComparer.Ordinal).ToArray());

            var temp = _persistPath + ".tmp";
            File.WriteAllText(temp, json);
            File.Move(temp, _persistPath, overwrite: true);
        }
        catch
        {
            // Igual que Load: no poder persistir degrada a "se re-aprende la
            // próxima sesión", nunca rompe el vuelo en curso.
        }
    }
}
