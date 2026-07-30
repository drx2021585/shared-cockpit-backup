import { useEffect, useRef, useState } from "react";
import type {
  AircraftSnapshot,
  ControlAxis,
  ControlEvent,
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

export interface BridgeControlValue {
  controlId: string;
  value: boolean | number | string;
  channel: "event" | "axis";
  updatedAt: number;
}

/**
 * Un `bridge.error` recibido del bridge local. Hasta ahora estos mensajes se
 * emitían y la UI los DESCARTABA (bridgeClient no manejaba el tipo), así que todo
 * el diagnóstico de escritura/lectura -- polaridad invertida, controles que no se
 * mueven, L-Vars inexistentes en la variante cargada -- solo existía como texto en
 * bridge.log, en %APPDATA%. Recogerlos acá es lo que permite el reporte
 * descargable.
 */
export interface BridgeErrorEntry {
  controlId: string;
  operation: string;
  message: string;
  timestamp: number;
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

/**
 * Cuántos bridge.error se conservan. Acotado a propósito: una sesión con un perfil
 * roto puede generar cientos y el reporte tiene que seguir siendo manejable. El
 * total real viaja en diagnostics.errorsReported, así que se puede saber si esto
 * truncó.
 */
const MAX_BRIDGE_ERRORS = 500;

export interface SimulatorBridgeState {
  mode: BridgeMode;
  connectionState: BridgeConnectionState;
  reconnecting: boolean;
  /** Últimos MAX_BRIDGE_ERRORS errores del bridge, en orden de llegada. */
  errors: BridgeErrorEntry[];
  /** Último bridge.diagnostics recibido (llega cada 5 s). */
  diagnostics: BridgeDiagnostics | null;
  /** Último aircraft.snapshot recibido (o generado en mock), si alguno. */
  snapshot: AircraftSnapshot | null;
  detectedProfileId: string | null;
  simulatorVersion: "msfs2020" | "msfs2024" | null;
  /** Últimos valores conocidos por controlId (control.event + control.axis fundidos). */
  controls: Record<string, BridgeControlValue>;
  lastMessageAt: number | null;
  /**
   * Envía un control.event/control.axis al bridge local (ej. un cambio que
   * llegó del compañero de vuelo por la sesión de red, ver useSessionSocket +
   * Cockpit.tsx). No-op en modo mock (no hay bridge real al que escribir) y
   * si el WebSocket no está abierto todavía.
   */
  send: (msg: ControlEvent | ControlAxis) => void;
}

const BRIDGE_WS_URL = "ws://localhost:7620";
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 15000;
// Si el socket nunca llega a abrir y se cierra antes de este umbral, se
// interpreta como "no hay nada escuchando en ese puerto" (bridge no
// corriendo) en vez de una desconexión intermitente normal.
const NO_BRIDGE_CLOSE_THRESHOLD_MS = 400;

export function resolveBridgeMode(): BridgeMode {
  const raw = (import.meta.env.VITE_BRIDGE_MODE as string | undefined)?.toLowerCase();
  return raw === "mock" ? "mock" : "real";
}

function emptyState(mode: BridgeMode, send: (msg: ControlEvent | ControlAxis) => void = () => {}): SimulatorBridgeState {
  return {
    mode,
    connectionState: "connecting",
    reconnecting: false,
    errors: [],
    diagnostics: null,
    snapshot: null,
    detectedProfileId: null,
    simulatorVersion: null,
    controls: {},
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
      simulatorVersion?: "msfs2020" | "msfs2024";
    };
    return {
      ...state,
      lastMessageAt: now,
      detectedProfileId: status.matchedProfileId ?? null,
      simulatorVersion: status.simulatorVersion ?? null,
    };
  }
  if ((msg as unknown as { type: string }).type === "bridge.error") {
    const err = msg as unknown as Partial<BridgeErrorEntry>;
    const entry: BridgeErrorEntry = {
      controlId: err.controlId ?? "",
      operation: err.operation ?? "unknown",
      message: err.message ?? "",
      timestamp: err.timestamp ?? now,
    };
    // Se conservan los MÁS RECIENTES: en una sesión con un perfil roto los
    // primeros errores son el estado inicial (todos iguales) y los últimos son los
    // que ocurrieron mientras se volaba, que es lo que interesa diagnosticar.
    const errors =
      state.errors.length >= MAX_BRIDGE_ERRORS
        ? [...state.errors.slice(state.errors.length - MAX_BRIDGE_ERRORS + 1), entry]
        : [...state.errors, entry];
    return { ...state, lastMessageAt: now, errors };
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
  // Token efímero emitido por electron/main.cjs al lanzar el bridge (null en
  // build web puro o si el bridge corre lanzado a mano) — ver preload.cjs.
  let bridgeToken: string | null = null;

  function send(msg: ControlEvent | ControlAxis) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify(msg));
  }

  setState(() => emptyState("real", send));

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
    const exp = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** currentAttempt, RECONNECT_MAX_DELAY_MS);
    const jitter = exp * (0.5 + Math.random() * 0.5);
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      if (!unmounted) connect();
    }, jitter);
  }

  function connect() {
    if (unmounted) return;
    connectStartedAt = Date.now();
    setState((s) => ({ ...s, connectionState: "connecting", reconnecting: attempt > 0 }));

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
      attempt = 0;
      setState((s) => ({ ...s, connectionState: "connected", reconnecting: false }));
    };

    socket.onmessage = (event) => {
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
      if (unmounted) return;
      const elapsed = Date.now() - connectStartedAt;
      const neverConnected = elapsed < NO_BRIDGE_CLOSE_THRESHOLD_MS;
      setState((s) => ({
        ...s,
        connectionState: neverConnected ? "no-bridge-running" : "disconnected",
      }));
      scheduleReconnect();
    };
  }

  // Se resuelve el token del bridge (IPC a Electron) antes del primer
  // connect. En build web puro no existe weconnectBridgeAuth y se conecta
  // sin token, igual que antes.
  const bridgeAuth = (window as unknown as {
    weconnectBridgeAuth?: { getToken: () => Promise<string | null> };
  }).weconnectBridgeAuth;
  Promise.resolve(bridgeAuth?.getToken() ?? null)
    .catch(() => null)
    .then((token) => {
      bridgeToken = token;
      if (!unmounted) connect();
    });

  return () => {
    unmounted = true;
    clearReconnectTimer();
    ws?.close();
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
        systems: {},
      },
      detectedProfileId: "mock-generic-aircraft",
      simulatorVersion: "msfs2020",
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
