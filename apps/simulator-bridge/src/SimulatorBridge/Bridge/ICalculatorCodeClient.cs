namespace SharedCockpit.Bridge.Bridge;

/// <summary>
/// Abstracción sobre un ejecutor de "calculator code" (RPN) contra MSFS, en el
/// mismo espíritu que IPmdgClientDataClient/ISimConnectClient: permite a
/// BridgeService orquestar sin acoplarse a la implementación real, y facilita
/// simular "no disponible" en tests sin tocar FSUIPC/SimConnect.
///
/// Confirmado EN VIVO (2026-07-27, MSFS 2024 + PMDG 737-900 real, avión en
/// tierra, sesión de Darwin) contra la implementación real
/// (SimConnectInterop/FsuipcLVarClient.cs, que además implementa esta interfaz):
/// FSUIPC7 expone su propio módulo WASM/WAPI ("John Dowson's WASM module",
/// FSUIPC_WAPID.dll) a través de FSUIPCClientDLL.MSFSVariableServices, con un
/// método ExecuteCalculatorCode(string) que SÍ funciona invocado desde un
/// proceso EXTERNO (no hace falta que el bridge mismo sea un módulo
/// WASM/gauge, ni tampoco hace falta habilitar la opción "Enable calculator
/// code execution from external SimConnect clients" en las Opciones de MSFS
/// -- FSUIPC7 ya trae su propio WASM module cargado, que es quien realmente
/// ejecuta el RPN dentro del sim). Esto reemplaza, para calculator code, al
/// enfoque de "requiere módulo WASM propio" documentado antes en
/// BridgeService.WriteControl.
///
/// IMPORTANTE (hallazgo real del mismo test en vivo): para el 737-900 de PMDG
/// NG3, los eventos K: legacy de eje (K:ELEVATOR_SET / K:AILERON_SET /
/// K:RUDDER_SET) NO mueven la superficie -- confirmado (before=during=0.0000
/// tras "3000 (>K:RUDDER_SET)"). PMDG NG3 solo escucha los eventos K: de EJE
/// real "AXIS_*_SET" (K:AXIS_RUDDER_SET / K:AXIS_ELEVATOR_SET /
/// K:AXIS_AILERON_SET), que SÍ movieron el rudder en la prueba en vivo:
/// "8000 (>K:AXIS_RUDDER_SET)" produjo A:RUDDER POSITION = -0.4883 (≈ -8000/16384,
/// signo invertido respecto al parámetro), y "-8000 (>K:AXIS_RUDDER_SET)"
/// produjo +0.4883 (relación lineal confirmada con dos puntos). Es decir:
/// param = -(target_position_menos_uno_a_uno * 16384), clamp [-16384, 16384].
/// Esto es lo que deben usar los perfiles corregidos de
/// aircraft-profiles/pmdg-737-900/controls/flight-controls.yaml (ver
/// aircraft-profiles-agent, no se tocó ese archivo desde aquí salvo que se
/// documente explícitamente).
/// </summary>
public interface ICalculatorCodeClient
{
    bool IsConnected { get; }

    /// <summary>Intenta abrir/inicializar el ejecutor de calculator code. No bloquea de forma indefinida: false si no puede quedar listo ahora mismo.</summary>
    bool TryConnect(string appName);

    /// <summary>
    /// Ejecuta el RPN dado. Devuelve false (y emite un warning por el canal
    /// correspondiente de la implementación) si el ejecutor no está listo
    /// todavía o si la ejecución lanzó una excepción -- nunca crashea el
    /// bridge.
    /// </summary>
    bool ExecuteCalculatorCode(string code);
}
