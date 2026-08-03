using System.Text.RegularExpressions;
using SharedCockpit.Bridge.Profiles;

namespace SharedCockpit.Bridge.Bridge;

/// <summary>
/// ====================================================================================
/// Reconoce los controles cuya escritura es un PULSO (pulsar/soltar un botón
/// momentáneo) en vez de fijar un estado estable.
///
/// POR QUÉ HACE FALTA DISTINGUIRLOS
/// --------------------------------
/// Dos optimizaciones del bridge asumen que escribir un control lo DEJA en el
/// valor pedido, y que leerlo después devuelve ese valor. Para un pulso eso es
/// falso: se pulsa y el control vuelve solo. Aplicarles esas dos optimizaciones
/// produce dos fallos distintos, y en el iFly 737 MAX 8 afectan a 568 controles
/// (los teclados del CDU/FMS, los botones del MCP, los de aviso...):
///
/// 1. `confirmAfterWrite` los REPITE. El lazo de convergencia escribe, espera ver
///    la lectura igualar el valor pedido, y reintenta hasta lograrlo. Un botón que
///    vuelve solo nunca sostiene ese valor, así que el lazo reintenta durante toda
///    la ventana (~9 veces en 6 s) y CADA reintento vuelve a pulsar la tecla. Una
///    pulsación del otro piloto podía escribir el mismo carácter nueve veces en el
///    CDU.
///
/// 2. `AlreadyAtValue` SUPRIME el soltar. Ese filtro (0.1.12) descarta la escritura
///    si el control ya está en el valor pedido, y es lo que arregló la avalancha al
///    conectar. Pero cuando llega el "soltar" (valor false) la L-Var ya suele leer 0,
///    así que el pulso de soltar se descartaba y el botón quedaba lógicamente
///    hundido dentro del iFly.
///
/// El comentario de AlreadyAtValue daba por hecho que los botones momentáneos eran
/// todos `writeOnly` y por eso quedaban fuera del filtro. En el iFly solo 71 de los
/// 639 momentáneos lo son: los otros 568 declaran `read` (su L-Var existe y sirve
/// para reflejar la pulsación en el otro asiento), y por eso caían dentro.
///
/// CÓMO SE DETECTAN
/// ----------------
/// Por la forma del RPN que emite tools/generate_ifly_profile.py para esta clase:
///
///   $value 0 &gt; if{ PULSA (&gt;L:trigger) } els{ SUELTA (&gt;L:trigger) }
///
/// La firma es el `els{` combinado con la comparación del valor contra 0: un
/// selector posicional compara contra `$value` y NO tiene rama `els{`, y un eje es
/// un SET absoluto sin condicional. Se detecta por la forma, y no por un campo
/// nuevo en el perfil, para no tocar packages/profile-schema (contrato compartido,
/// requiere pasar por el orchestrator -- ver CLAUDE.md).
/// ====================================================================================
/// </summary>
public static class MomentaryPulse
{
    private const string IflyControlAreaName = "iFly737MAX_SDK_Control";
    private sealed record SinglePressShape(string TriggerLVar, int CommandCode);

    /// <summary>
    /// `$value 0 >` (o `<`) seguido en algún punto de una rama `els{`: pulsar en un
    /// sentido, soltar en el otro. El `\s*` permite las variaciones de espaciado
    /// que emite el generador.
    /// </summary>
    private static readonly Regex PulseShape = new(
        @"\$value\s+0\s*[<>].*\bels\{",
        RegexOptions.Compiled | RegexOptions.Singleline);

    /// <summary>
    /// Botón momentáneo de UN solo disparo, sin rama `els{}` y sin L-Var de estado:
    ///
    ///   $value 0 > if{ 83 (>L:VC_Communications_trigger_VAL,number) }
    ///
    /// El bridge puede escuchar esa L-Var de trigger y traducir el código 83 de
    /// vuelta a `control.event true`, cerrando la sincronización desde clic local
    /// de cabina hacia la red para controles `writeOnly`.
    /// </summary>
    private static readonly Regex SinglePressShapeRegex = new(
        @"^\s*\$value\s+0\s*>\s*if\{\s*(?<code>-?\d+)\s*\(> (?<trigger>L:[^,\)]+),\s*number\)\s*\}\s*$"
            .Replace("> ", ">"),
        RegexOptions.Compiled | RegexOptions.Singleline);

    public static bool IsPulse(string? rpn) => rpn is not null && PulseShape.IsMatch(rpn);

    public static bool TryParseSinglePress(string? rpn, out string triggerLVar, out int commandCode)
    {
        triggerLVar = string.Empty;
        commandCode = 0;

        if (rpn is null)
        {
            return false;
        }

        var match = SinglePressShapeRegex.Match(rpn);
        if (!match.Success)
        {
            return false;
        }

        triggerLVar = match.Groups["trigger"].Value;
        commandCode = int.Parse(match.Groups["code"].Value, System.Globalization.CultureInfo.InvariantCulture);
        return true;
    }

    /// <summary>
    /// ¿Este control se escribe como un pulso?
    ///
    /// Originalmente solo aplicaba a write.type=calculatorCode (forma RPN de dos
    /// ramas del generador iFly). Al portar los botones momentáneos del MCP al SDK
    /// oficial de iFly apareció la misma semántica por otro canal:
    ///
    ///   write.type=clientDataEvent
    ///   areaName: iFly737MAX_SDK_Control
    ///   event: KEY_COMMAND_*          // Click/Press
    ///
    /// En el header del SDK los SET absolutos terminan en _SET y los selectores
    /// relativos en _INC/_DEC; los Click/Press NO. Para dataType=boolean esa forma
    /// también representa un pulso momentáneo y debe quedar fuera de
    /// confirmAfterWrite, AlreadyAtValue, debounce y eco exactamente igual que la
    /// forma RPN.
    /// </summary>
    public static bool IsPulseControl(ControlDefinition control)
    {
        var write = control.Write;
        if (write is null)
        {
            return false;
        }

        if (write.Type == WriteType.CalculatorCode)
        {
            return IsPulse(write.Name);
        }

        if (write.Type != WriteType.ClientDataEvent
            || control.DataType != ControlDataType.Boolean
            || !string.Equals(write.AreaName, IflyControlAreaName, StringComparison.Ordinal)
            || string.IsNullOrWhiteSpace(write.Event))
        {
            return false;
        }

        return write.Event.StartsWith("KEY_COMMAND_", StringComparison.Ordinal)
            && !write.Event.EndsWith("_SET", StringComparison.Ordinal)
            && !write.Event.EndsWith("_INC", StringComparison.Ordinal)
            && !write.Event.EndsWith("_DEC", StringComparison.Ordinal);
    }
}
