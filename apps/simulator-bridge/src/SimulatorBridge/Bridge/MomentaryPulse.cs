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
    /// <summary>
    /// `$value 0 >` (o `<`) seguido en algún punto de una rama `els{`: pulsar en un
    /// sentido, soltar en el otro. El `\s*` permite las variaciones de espaciado
    /// que emite el generador.
    /// </summary>
    private static readonly Regex PulseShape = new(
        @"\$value\s+0\s*[<>].*\bels\{",
        RegexOptions.Compiled | RegexOptions.Singleline);

    public static bool IsPulse(string? rpn) => rpn is not null && PulseShape.IsMatch(rpn);

    /// <summary>
    /// ¿Este control se escribe como un pulso? Solo aplica a write.type=calculatorCode:
    /// las otras formas de escritura (inputEvent, hvar, clientDataEvent) tienen su
    /// propia semántica y no se tocan acá.
    /// </summary>
    public static bool IsPulseControl(ControlDefinition control) =>
        control.Write is { Type: WriteType.CalculatorCode } write && IsPulse(write.Name);
}
