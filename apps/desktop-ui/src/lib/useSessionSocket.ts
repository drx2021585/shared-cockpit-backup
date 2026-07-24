import { useEffect, useRef, useState } from "react";
import type { Session } from "./apiClient";
import { apiBaseUrl } from "./apiClient";

export interface SessionSocketState {
  connected: boolean;
  session: Session | null;
  pingMs: number | null;
  /** true mientras se está esperando/reintentando tras una desconexión. */
  reconnecting: boolean;
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
export function useSessionSocket(joinCode: string | null, pilotName: string | null): SessionSocketState {
  const [state, setState] = useState<SessionSocketState>({
    connected: false,
    session: null,
    pingMs: null,
    reconnecting: false,
  });
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
      const ws = new WebSocket(
        `${wsUrl}/ws?code=${encodeURIComponent(joinCode!)}&pilot=${encodeURIComponent(pilotName!)}`,
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
        }
      };

      ws.onclose = (event) => {
        clearPingTimer();
        setState((s) => ({ ...s, connected: false }));
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

  return state;
}
