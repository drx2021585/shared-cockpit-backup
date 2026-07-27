import { useEffect, useRef, useState } from "react";
import type { Session } from "./apiClient";
import { apiBaseUrl, getParticipantToken } from "./apiClient";
import type { AuthorityTransfer, ControlAxis, ControlEvent } from "../../../../packages/protocol/types";

export interface SessionSocketState {
  connected: boolean;
  session: Session | null;
  pingMs: number | null;
  /** true mientras se está esperando/reintentando tras una desconexión. */
  reconnecting: boolean;
  sessionClosed: boolean;
  peerAircraft: Record<string, {
    profileId: string;
    simulatorVersion: "msfs2020" | "msfs2024" | null;
  }>;
  /**
   * Envía un control.event/control.axis a la sesión de red (ej. un cambio
   * que llegó del bridge local propio, ver bridgeClient + Cockpit.tsx). No-op
   * si el WebSocket de sesión no está abierto todavía.
   */
  send: (msg: ControlEvent | ControlAxis) => void;
}

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 15000;

/**
 * Conecta al WebSocket real del backend para un código de sesión y piloto
 * dados. El ping mostrado es medido de verdad (round-trip real), no un
 * número fijo como en el diseño original.
 *
 * Reconexión: si el socket se cierra de forma inesperada (no por
 * desmontaje del componente ni por cierre intencional del servidor por
 * sesión/piloto inválido, código 4000), se reintenta con backoff
 * exponencial (500ms, 1s, 2s, 4s... hasta un tope de 15s) más jitter, hasta
 * que se reconecta o el componente se desmonta.
 */
export function useSessionSocket(
  joinCode: string | null,
  pilotName: string | null,
  initialSession: Session | null = null,
  localProfileId: string | null = null,
  localSimulatorVersion: "msfs2020" | "msfs2024" | null = null,
  onPeerControl?: (msg: ControlEvent | ControlAxis) => void,
): SessionSocketState {
  const [state, setState] = useState<SessionSocketState>({
    connected: false,
    session: initialSession,
    pingMs: null,
    reconnecting: false,
    sessionClosed: false,
    peerAircraft: {},
    send: () => {},
  });
  // Callback siempre actualizado sin forzar que el efecto de conexión (que no
  // debe reconectar solo porque cambió la identidad de la función) dependa de
  // onPeerControl -- mismo patrón que wsRef.
  const onPeerControlRef = useRef(onPeerControl);
  onPeerControlRef.current = onPeerControl;
  const wsRef = useRef<WebSocket | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const unmountedRef = useRef(false);

  useEffect(() => {
    if (!joinCode || !pilotName) return;

    unmountedRef.current = false;
    attemptRef.current = 0;

    function clearPingTimer() {
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
    }

    function clearReconnectTimer() {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    }

    function scheduleReconnect() {
      if (unmountedRef.current) return;
      const attempt = attemptRef.current;
      attemptRef.current += 1;
      const exp = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
      const jitter = exp * (0.5 + Math.random() * 0.5); // entre 50% y 100% del delay
      setState((s) => ({ ...s, connected: false, reconnecting: true }));
      clearReconnectTimer();
      reconnectTimerRef.current = setTimeout(() => {
        if (!unmountedRef.current) connect();
      }, jitter);
    }

    function connect() {
      if (unmountedRef.current) return;
      const wsUrl = apiBaseUrl().replace(/^http/, "ws");
      // La identidad la da el token de participante (emitido en create/join);
      // el servidor deriva el piloto del token, no de un nombre en la query.
      const token = getParticipantToken() ?? "";
      const ws = new WebSocket(
        `${wsUrl}/ws?code=${encodeURIComponent(joinCode!)}&token=${encodeURIComponent(token)}`,
      );
      wsRef.current = ws;

      ws.onopen = () => {
        attemptRef.current = 0; // reconexión exitosa: resetea el backoff
        setState((s) => ({ ...s, connected: true, reconnecting: false }));
        clearPingTimer();
        pingTimerRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping", clientSentAt: Date.now() }));
          }
        }, 4000);
        // primer ping inmediato
        ws.send(JSON.stringify({ type: "ping", clientSentAt: Date.now() }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "session.state") {
          setState((s) => ({ ...s, session: msg.session }));
        } else if (msg.type === "pong") {
          const rtt = Date.now() - msg.clientSentAt;
          setState((s) => ({ ...s, pingMs: rtt }));
        } else if (msg.type === "aircraft.snapshot" && msg.sourcePilot && msg.profile) {
          setState((s) => ({
            ...s,
            peerAircraft: {
              ...s.peerAircraft,
              [msg.sourcePilot]: {
                profileId: msg.profile,
                simulatorVersion: msg.simulatorVersion ?? null,
              },
            },
          }));
        } else if (msg.type === "control.event" || msg.type === "control.axis") {
          // Cambio real del compañero de vuelo (switch o eje) reenviado por
          // server/api -- Cockpit.tsx lo aplica al bridge local propio. Este
          // hook NO lo guarda en React state (llegarían decenas por segundo
          // en el canal rápido, control.axis) -- se entrega por callback.
          onPeerControlRef.current?.(msg as ControlEvent | ControlAxis);
        } else if (msg.type === "authority.transfer") {
          // Broadcast real de server/api (packages/protocol AuthorityTransfer):
          // { type, sessionId, group, previousOwner, newOwner, revision }, con
          // previousOwner/newOwner como `seat` ("captain" | "first_officer"),
          // no pilotName. Reflejamos el cambio de dueño de controles de
          // inmediato en el estado local sin esperar al próximo
          // `session.state` completo — session.state igual lo confirmará.
          const transfer = msg as AuthorityTransfer;
          setState((s) =>
            s.session
              ? {
                  ...s,
                  session: {
                    ...s.session,
                    controlOwner: transfer.newOwner,
                    controlRequestedBy: null,
                  },
                }
              : s
          );
        }
      };

      ws.onclose = (event) => {
        clearPingTimer();
        setState((s) => ({ ...s, connected: false }));
        if (event.code === 4001) {
          setState((s) => ({ ...s, reconnecting: false, sessionClosed: true }));
          return;
        }
        // 4000 = código de sesión o piloto inválido (ver server.ts): no tiene
        // sentido reintentar, es un error permanente de esta combinación.
        if (event.code === 4000 || unmountedRef.current) {
          setState((s) => ({ ...s, reconnecting: false }));
          return;
        }
        scheduleReconnect();
      };
    }

    connect();

    return () => {
      unmountedRef.current = true;
      clearPingTimer();
      clearReconnectTimer();
      wsRef.current?.close();
    };
  }, [joinCode, pilotName]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!joinCode || !localProfileId || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: "aircraft.snapshot",
      sessionId: joinCode,
      revision: 0,
      profile: localProfileId,
      simulatorVersion: localSimulatorVersion,
      systems: {},
    }));
  }, [
    joinCode,
    localProfileId,
    localSimulatorVersion,
    state.connected,
    state.session?.participants.length,
  ]);

  // send se define acá (no dentro del efecto de conexión) para que sea una
  // función estable que siempre lee el WebSocket vigente vía wsRef, sin
  // depender de closures potencialmente obsoletas de una conexión anterior.
  function send(msg: ControlEvent | ControlAxis) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify(msg));
  }

  return { ...state, send };
}
