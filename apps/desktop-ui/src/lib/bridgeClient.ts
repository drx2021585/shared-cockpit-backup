import { useEffect, useRef, useState } from "react";
import { recordBridgeError, type BridgeErrorEntry } from "./bridgeErrorLog";
import type {
  AircraftSnapshot,
  ControlAxis,
  ControlEvent,
  FlightPose,
  ScreenSnapshot,
  SharedCockpitMessage,
} from "../../../../packages/protocol/types";

/**
 * Cliente hacia apps/simulator-bridge (agente simconnect-bridge-agent), el
 * proceso local en C#/.NET que habla SimConnect y expone un WebSocket en
 * ws://localhost:7620 con los mensajes de packages/protocol/types.ts
 * (control.event, control.axis, aircraft.snapshot). Este archivo NO habla
 * con SimConnect ni con la red externa directamente — solo consume ese
 * WebSocket local, igual que useSessionSocket.ts consume server/api.
 *
 * Modo `mock`: no abre ningún socket. Genera cambios locales deterministas
 * para poder diseñar/probar la pantalla de cabina sin MSFS ni el bridge real
 * corriendo. Todo estado que salga de acá en modo mock queda marcado
 * `mode: "mock"` — la UI está obligada a mostrarlo como tal (ver Cockpit.tsx).
 * Nunca se debe presentar como telemetría real.
 *
 * Modo `real` (default): WebSocket real a ws://localhost:7620. Si no hay
 * nada escuchando ahí (bridge no instalado/corriendo, o MSFS no abierto),
 * el estado se refleja honestamente como desconectado — no se rellena con
 * datos de ejemplo.
 */

export type BridgeMode = "mock" | "real";

export type BridgeConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "no-bridge-running";

export const MIN_SUPPORTED_BRIDGE_API_VERSION = 2;

export interface BridgeReplaceResult {
  ok: boolean;
  reason: string;
}

/**
 * Le pide a Electron que mate el bridge que esté escuchando en el 7620 y arranque
 * el empaquetado con la app. Es la salida para el caso en que un bridge viejo
 * quedó corriendo (lanzado a mano o de una versión anterior): la app se pega a él
 * porque el puerto ya responde, y sin esto el único arreglo era el Task Manager.
 *
 * Devuelve null fuera de Electron (build web), donde no hay proceso que matar.
 */
export async function replaceStaleBridge(): Promise<BridgeReplaceResult | null> {
  const auth = (window as unknown as {
    weconnectBridgeAuth?: { replaceStale?: () => Promise<BridgeReplaceResult> };
  }).weconnectBridgeAuth;
  if (!auth?.replaceStale) return null;
  try {
    return await auth.replaceStale();
  } catch {
    return { ok: false, reason: "ipc-failed" };
  }
}

export interface BridgeControlValue {
  controlId: string;
  value: boolean | number | string;
  channel: "event" | "axis";
  updatedAt: number;
}

/** Contadores agregados del bridge (mensaje bridge.diagnostics). */
export interface BridgeDiagnostics {
  matchedProfileId: string | null;
  detectedTitle: string | null;
  controlsSubscribed: number;
  writesAttempted: number;
  writesSkippedAlreadyAtValue: number;
  writesConfirmed: number;
  writesFailed: number;
  polarityInversionsLearned: number;
  pulsePressesWritten: number;
  errorsReported: number;
  /** Controles cuya polaridad el bridge midió y corrigió en vivo. Es la lista que
   * se vuelca a los YAML del perfil para que llegue a todos los jugadores. */
  polarityInvertedControls: string[];
  timestamp: number;
}

export interface BridgeScreenSnapshot {
  screenId: string;
  rows: number;
  cols: number;
  cells: ScreenSnapshot["cells"];
  powered: boolean | null;
  revision: number;
  updatedAt: number;
}

export interface BridgeFlightPose extends FlightPose {
  updatedAt: number;
}

export interface SimulatorBridgeState {
  mode: BridgeMode;
  connectionState: BridgeConnectionState;
  reconnecting: boolean;
  /**
   * Último bridge.diagnostics recibido (llega cada 5 s). Los bridge.error NO viven
   * acá a propósito: van a lib/bridgeErrorLog.ts, que explica por qué (meterlos en
   * el estado de React provocaba un re-render por error, y llegan a cientos en
   * ráfaga). El contador en vivo sale de diagnostics.errorsReported.
   */
  diagnostics: BridgeDiagnostics | null;
  /** Último aircraft.snapshot recibido (o generado en mock), si alguno. */
  snapshot: AircraftSnapshot | null;
  detectedProfileId: string | null;
  detectedTitle: string | null;
  simulatorVersion: "msfs2020" | "msfs2024" | null;
  bridgeApiVersion: number | null;
  bridgeBuildVersion: string | null;
  pose: BridgeFlightPose | null;
  /** Últimos valores conocidos por controlId (control.event + control.axis fundidos). */
  controls: Record<string, BridgeControlValue>;
  /** Última pantalla conocida por screenId (ej. cdu_captain/cdu_fo). */
  screens: Record<string, BridgeScreenSnapshot>;
  lastMessageAt: number | null;
  /**
   * Envía un control.event/control.axis al bridge local (ej. un cambio que
   * llegó del compañero de vuelo por la sesión de red, ver useSessionSocket +
   * Cockpit.tsx). No-op en modo mock (no hay bridge real al que escribir) y
   * si el WebSocket no está abierto todavía.
   */
  send: (msg: ControlEvent | ControlAxis | FlightPose) => void;
  /**
   * Fuerza un intento de reconexión YA: descarta el backoff acumulado, tira el
   * socket viejo y reconecta pidiendo un token fresco. Lo usa el botón
   * "Reconnect" de la cabina y también los despertares de ventana (focus/online).
   */
  reconnectNow: () => void;
}

const BRIDGE_WS_URL = "ws://localhost:7620";
// Reconexión agresiva a propósito: el bridge es un proceso local, así que
// reintentar rápido no cuesta red. Con el backoff viejo (500ms base, tope 15s)
// una caída al pasar control dejaba la cabina muerta más de un minuto aunque el
// bridge ya estuviera de vuelta.
const RECONNECT_BASE_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 3000;
// Cierres inmediatos seguidos tras los cuales se asume que el bridge está
// RECHAZANDO la conexión (token desincronizado, ver electron/main.cjs) en vez de
// estar apagado. Reintentar con el mismo token no arregla eso nunca: hay que
// reemplazar el proceso para que regenere uno.
const FAST_CLOSES_BEFORE_REPLACE = 3;
// Si el socket nunca llega a abrir y se cierra antes de este umbral, se
// interpreta como "no hay nada escuchando en ese puerto" (bridge no
// corriendo) en vez de una desconexión intermitente normal.
const NO_BRIDGE_CLOSE_THRESHOLD_MS = 400;

export function resolveBridgeMode(): BridgeMode {
  const raw = (import.meta.env.VITE_BRIDGE_MODE as string | undefined)?.toLowerCase();
  return raw === "mock" ? "mock" : "real";
}

function emptyState(
  mode: BridgeMode,
  send: (msg: ControlEvent | ControlAxis | FlightPose) => void = () => {},
  reconnectNow: () => void = () => {},
): SimulatorBridgeState {
  return {
    mode,
    reconnectNow,
    connectionState: "connecting",
    reconnecting: false,
    diagnostics: null,
    snapshot: null,
    detectedProfileId: null,
    detectedTitle: null,
    simulatorVersion: null,
    bridgeApiVersion: null,
    bridgeBuildVersion: null,
    pose: null,
    controls: {},
    screens: {},
    lastMessageAt: null,
    send,
  };
}

function applyMessage(
  state: SimulatorBridgeState,
  msg: SharedCockpitMessage
): SimulatorBridgeState {
  const now = Date.now();
  if ((msg as unknown as { type: string }).type === "bridge.status") {
    const status = msg as unknown as {
      matchedProfileId?: string | null;
      detectedTitle?: string | null;
      simulatorVersion?: "msfs2020" | "msfs2024";
      bridgeApiVersion?: number;
      bridgeBuildVersion?: string | null;
    };
    return {
      ...state,
      lastMessageAt: now,
      detectedProfileId: status.matchedProfileId ?? null,
      detectedTitle: status.detectedTitle ?? null,
      simulatorVersion: status.simulatorVersion ?? null,
      bridgeApiVersion:
        typeof status.bridgeApiVersion === "number" ? status.bridgeApiVersion : null,
      bridgeBuildVersion:
        typeof status.bridgeBuildVersion === "string" ? status.bridgeBuildVersion : null,
    };
  }
  if ((msg as unknown as { type: string }).type === "bridge.error") {
    const err = msg as unknown as Partial<BridgeErrorEntry>;
    recordBridgeError({
      controlId: err.controlId ?? "",
      operation: err.operation ?? "unknown",
      message: err.message ?? "",
      timestamp: err.timestamp ?? now,
    });
    // Se devuelve el estado IDÉNTICO (no una copia con lastMessageAt nuevo): así
    // React descarta el render. Estos mensajes llegan a cientos en ráfaga cuando un
    // perfil declara L-Vars que la aeronave cargada no tiene, y en la 0.1.14 cada
    // uno forzaba un re-render de toda la app -- se notaba como botones que
    // tardaban en responder al arrancar. Ver lib/bridgeErrorLog.ts.
    return state;
  }
  if ((msg as unknown as { type: string }).type === "bridge.diagnostics") {
    return {
      ...state,
      lastMessageAt: now,
      diagnostics: msg as unknown as BridgeDiagnostics,
    };
  }
  if (msg.type === "control.event") {
    const event = msg as ControlEvent;
    return {
      ...state,
      lastMessageAt: now,
      controls: {
        ...state.controls,
        [event.controlId]: {
          controlId: event.controlId,
          value: event.value,
          channel: "event",
          updatedAt: now,
        },
      },
    };
  }
  if (msg.type === "control.axis") {
    const axis = msg as ControlAxis;
    return {
      ...state,
      lastMessageAt: now,
      controls: {
        ...state.controls,
        [axis.controlId]: {
          controlId: axis.controlId,
          value: axis.value,
          channel: "axis",
          updatedAt: now,
        },
      },
    };
  }
  if (msg.type === "aircraft.snapshot") {
    return { ...state, lastMessageAt: now, snapshot: msg as AircraftSnapshot };
  }
  if (msg.type === "flight.pose") {
    return {
      ...state,
      lastMessageAt: now,
      pose: {
        ...(msg as FlightPose),
        updatedAt: now,
      },
    };
  }
  if (msg.type === "screen.snapshot") {
    const screen = msg as ScreenSnapshot;
    return {
      ...state,
      lastMessageAt: now,
      screens: {
        ...state.screens,
        [screen.screenId]: {
          screenId: screen.screenId,
          rows: screen.rows,
          cols: screen.cols,
          cells: screen.cells,
          powered: screen.powered ?? null,
          revision: screen.revision,
          updatedAt: now,
        },
      },
    };
  }
  // authority.transfer / session.* no describen telemetría de aeronave; los
  // ignoramos acá (le corresponden a otras pantallas/agentes).
  return { ...state, lastMessageAt: now };
}

/**
 * Hook principal. `mode` es opcional — por defecto usa VITE_BRIDGE_MODE
 * (o "real" si no está definida), igual que el resto de los hooks de red
 * de esta app.
 */
export function useSimulatorBridge(mode: BridgeMode = resolveBridgeMode()): SimulatorBridgeState {
  const [state, setState] = useState<SimulatorBridgeState>(() => emptyState(mode));

  useEffect(() => {
    if (mode === "mock") {
      return runMockBridge(setState);
    }
    return runRealBridge(setState);
  }, [mode]);

  return state;
}

// ---------------------------------------------------------------------------
// Modo real
// ---------------------------------------------------------------------------

function runRealBridge(setState: (updater: (s: SimulatorBridgeState) => SimulatorBridgeState) => void) {
  let unmounted = false;
  let ws: WebSocket | null = null;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectStartedAt = 0;
  // Cierres inmediatos seguidos (el bridge acepta el TCP y corta al instante):
  // firma de "conexión rechazada", no de "bridge apagado".
  let fastCloses = 0;
  // Se permite un solo reemplazo automático del proceso por racha; se rearma al
  // volver a conectar, para no entrar en un bucle de matar/relanzar.
  let replaceAttempted = false;
  // Cada connect() se lleva una generación. Los handlers de un socket viejo que
  // llega tarde (o de uno descartado por reconnectNow) se ignoran comparando
  // contra la generación viva, así dos sockets nunca se pisan el estado.
  let generation = 0;
  const bridgeAuth = (window as unknown as {
    weconnectBridgeAuth?: { getToken: () => Promise<string | null> };
  }).weconnectBridgeAuth;

  function send(msg: ControlEvent | ControlAxis | FlightPose) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify(msg));
  }

  /** Descarta el socket actual sin que su onclose dispare otra reconexión. */
  function discardSocket() {
    const stale = ws;
    ws = null;
    if (!stale) return;
    stale.onopen = null;
    stale.onmessage = null;
    stale.onerror = null;
    stale.onclose = null;
    try {
      stale.close();
    } catch {
      // Ya estaba cerrado o cerrándose: nada que hacer.
    }
  }

  function reconnectNow() {
    if (unmounted) return;
    attempt = 0;
    fastCloses = 0;
    replaceAttempted = false;
    clearReconnectTimer();
    discardSocket();
    void connect();
  }

  setState(() => emptyState("real", send, reconnectNow));

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    if (unmounted) return;
    const currentAttempt = attempt;
    attempt += 1;
    clearReconnectTimer();
    // El primer reintento es inmediato: cubre el caso común (el bridge se
    // reinició y ya volvió a escuchar) sin que la cabina se quede en blanco.
    if (currentAttempt === 0) {
      reconnectTimer = setTimeout(() => {
        if (!unmounted) void connect();
      }, 0);
      return;
    }
    const exp = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (currentAttempt - 1), RECONNECT_MAX_DELAY_MS);
    const jitter = exp * (0.5 + Math.random() * 0.5);
    reconnectTimer = setTimeout(() => {
      if (!unmounted) void connect();
    }, jitter);
  }

  async function resolveBridgeToken() {
    try {
      return await Promise.resolve(bridgeAuth?.getToken() ?? null);
    } catch {
      return null;
    }
  }

  async function connect() {
    if (unmounted) return;
    const myGeneration = ++generation;
    connectStartedAt = Date.now();
    setState((s) => ({ ...s, connectionState: "connecting", reconnecting: attempt > 0 }));

    const bridgeToken = await resolveBridgeToken();
    if (unmounted || myGeneration !== generation) {
      return;
    }

    let socket: WebSocket;
    try {
      const url = bridgeToken
        ? `${BRIDGE_WS_URL}/?token=${encodeURIComponent(bridgeToken)}`
        : BRIDGE_WS_URL;
      socket = new WebSocket(url);
    } catch {
      // Construcción del WebSocket falló (URL inválida, entorno sin soporte,
      // etc.) — tratado igual que "no hay bridge" para no dejar la UI colgada.
      setState((s) => ({ ...s, connectionState: "no-bridge-running", reconnecting: false }));
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.onopen = () => {
      if (unmounted || myGeneration !== generation) return;
      attempt = 0;
      fastCloses = 0;
      replaceAttempted = false;
      setState((s) => ({ ...s, connectionState: "connected", reconnecting: false }));
    };

    socket.onmessage = (event) => {
      if (unmounted || myGeneration !== generation) return;
      try {
        const msg = JSON.parse(event.data) as SharedCockpitMessage;
        setState((s) => applyMessage(s, msg));
      } catch {
        // Mensaje no parseable: se descarta, no se rompe la conexión.
      }
    };

    socket.onerror = () => {
      // El evento de error real llega también por onclose; no duplicamos
      // el manejo de estado acá, solo evitamos que quede sin capturar.
    };

    socket.onclose = () => {
      if (unmounted || myGeneration !== generation) return;
      const elapsed = Date.now() - connectStartedAt;
      const neverConnected = elapsed < NO_BRIDGE_CLOSE_THRESHOLD_MS;
      fastCloses = neverConnected ? fastCloses + 1 : 0;
      setState((s) => ({
        ...s,
        connectionState: neverConnected ? "no-bridge-running" : "disconnected",
      }));

      // Varios cierres instantáneos seguidos no son "el bridge está apagado":
      // si estuviera apagado el TCP ni conectaría. Es el bridge rechazándonos
      // por token, y reintentar con el mismo token no converge nunca. Se
      // reemplaza el proceso una vez para que regenere token y lo persista.
      if (fastCloses >= FAST_CLOSES_BEFORE_REPLACE && !replaceAttempted) {
        replaceAttempted = true;
        void replaceStaleBridge().then((result) => {
          if (unmounted || !result?.ok) return;
          fastCloses = 0;
          attempt = 0;
        });
      }

      scheduleReconnect();
    };
  }

  // Volver a la ventana o recuperar la red son señales de que vale la pena
  // reintentar YA en vez de esperar a que venza el backoff.
  function handleWakeup() {
    if (unmounted || (ws && ws.readyState === WebSocket.OPEN)) return;
    reconnectNow();
  }
  window.addEventListener("focus", handleWakeup);
  window.addEventListener("online", handleWakeup);

  void connect();

  return () => {
    unmounted = true;
    window.removeEventListener("focus", handleWakeup);
    window.removeEventListener("online", handleWakeup);
    clearReconnectTimer();
    discardSocket();
  };
}

// ---------------------------------------------------------------------------
// Modo mock — datos simulados, honestamente etiquetados en el estado (mode:
// "mock"). La UI es responsable de mostrar ese tag; este archivo solo
// garantiza que el campo exista y sea correcto.
// ---------------------------------------------------------------------------

const MOCK_CONTROLS: Array<{ controlId: string; channel: "event" | "axis"; values: (boolean | number | string)[] }> = [
  { controlId: "nav_lights", channel: "event", values: [true, false] },
  { controlId: "landing_lights", channel: "event", values: [false, true] },
  { controlId: "parking_brake", channel: "event", values: [true, false] },
  { controlId: "autopilot_master", channel: "event", values: [false, true] },
  { controlId: "throttle_1", channel: "axis", values: [0, 0.35, 0.62, 0.81, 1] },
  { controlId: "elevator_trim", channel: "axis", values: [-0.05, 0, 0.02, 0.06] },
];

function runMockBridge(setState: (updater: (s: SimulatorBridgeState) => SimulatorBridgeState) => void) {
  let cancelled = false;
  let sequence = 0;

  setState(() => ({ ...emptyState("mock"), connectionState: "connecting" }));

  // Simula el tiempo de "conexión" al bridge antes de empezar a emitir datos.
  const connectTimer = setTimeout(() => {
    if (cancelled) return;
    setState((s) => ({
      ...s,
      connectionState: "connected",
      snapshot: {
        type: "aircraft.snapshot",
        sessionId: "mock-session",
        revision: 0,
        profile: "mock-generic-aircraft",
        simulatorVersion: "msfs2020",
        detectedTitle: "Mock Generic Aircraft",
        appVersion: "mock",
        systems: {},
      },
      detectedProfileId: "mock-generic-aircraft",
      detectedTitle: "Mock Generic Aircraft",
      simulatorVersion: "msfs2020",
      bridgeApiVersion: MIN_SUPPORTED_BRIDGE_API_VERSION,
      bridgeBuildVersion: "mock",
      pose: {
        type: "flight.pose",
        sessionId: "mock-session",
        sequence: 1,
        timestamp: Date.now(),
        lat: 18.438,
        lon: -66.002,
        alt: 1200,
        pitch: 1.5,
        bank: 0.2,
        heading: 182,
        groundSpeed: 138,
        indicatedAirspeed: 136,
        verticalSpeed: 200,
        updatedAt: Date.now(),
      },
    }));
  }, 400);

  const tickTimer = setInterval(() => {
    if (cancelled) return;
    const control = MOCK_CONTROLS[sequence % MOCK_CONTROLS.length];
    const value = control.values[Math.floor(sequence / MOCK_CONTROLS.length) % control.values.length];
    sequence += 1;
    setState((s) =>
      applyMessage(s, {
        type: control.channel === "event" ? "control.event" : "control.axis",
        sessionId: "mock-session",
        controlId: control.controlId,
        value,
        source: "mock",
        sequence,
        timestamp: Date.now(),
      } as SharedCockpitMessage)
    );
  }, 1500);

  return () => {
    cancelled = true;
    clearTimeout(connectTimer);
    clearInterval(tickTimer);
  };
}
