import { useSessionSocket } from "../lib/useSessionSocket";
import { usePublicIp } from "../lib/useNetworkInfo";
import { useAircraftProfiles } from "../lib/useAircraftProfiles";
import { useSimulatorBridge } from "../lib/bridgeClient";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  closeSession,
  leaveSession,
  requestControls,
  giveControls,
  type Session,
  type SessionParticipant,
} from "../lib/apiClient";
import type { ControlAxis, ControlEvent } from "../../../../packages/protocol/types";

/**
 * Cuánto tiempo se suprime el reenvío de un valor que acabamos de aplicar
 * porque llegó del compañero de vuelo -- evita el loop control.axis/event
 * peer→bridge local→(se relee igual)→session→peer otra vez. 3s es generoso
 * para el canal confiable (control.event, ~150ms de debounce en el bridge);
 * para el canal rápido (control.axis, 20-60Hz) el valor exacto rara vez se
 * repite dos veces seguidas de todos modos (ejes continuos), así que el
 * riesgo real de este guard es solo para switches booleanos.
 */
const ECHO_SUPPRESSION_MS = 3000;

interface CockpitProps {
  joinCode: string | null;
  pilotName: string | null;
  initialSession?: Session | null;
  onSessionClosed?: () => void;
}

const SEAT_LABEL: Record<string, string> = {
  captain: "Captain",
  first_officer: "First officer",
  observer: "Observer",
};

/**
 * `controlOwner`/`controlRequestedBy` en `Session` son un `seat`
 * ("captain" | "first_officer"), no un `pilotName` (server/api los cambió a
 * seat para poder resolver autoridad sin depender de nombres). Para mostrar
 * algo útil en la UI, se resuelve el nombre del piloto sentado en ese seat;
 * si nadie ocupa ese seat todavía, se cae al label genérico del seat.
 */
function seatOwnerLabel(seat: string | null, participants: SessionParticipant[]): string {
  if (!seat) return "—";
  const owner = participants.find((p) => p.seat === seat);
  return owner ? owner.pilot_name : (SEAT_LABEL[seat] ?? seat);
}

export function Cockpit({
  joinCode,
  pilotName,
  initialSession = null,
  onSessionClosed,
}: CockpitProps) {
  const bridge = useSimulatorBridge();
  const localProfileId = bridge.detectedProfileId ?? bridge.snapshot?.profile ?? null;

  // Valores (controlId -> {value, until}) que acabamos de escribir en el
  // bridge local PORQUE llegaron del compañero de vuelo -- si el bridge los
  // relee y los vuelve a emitir (mismo valor), no hay que reenviarlos a la
  // sesión de red, o se generaría un eco infinito peer→yo→peer→yo...
  const suppressEchoRef = useRef<Map<string, { value: unknown; until: number }>>(new Map());

  const handlePeerControl = useCallback(
    (msg: ControlEvent | ControlAxis) => {
      suppressEchoRef.current.set(msg.controlId, { value: msg.value, until: Date.now() + ECHO_SUPPRESSION_MS });
      bridge.send(msg);
    },
    [bridge],
  );

  const { connected, session, pingMs, sessionClosed, peerAircraft, send: sendToSession } = useSessionSocket(
    joinCode,
    pilotName,
    initialSession,
    localProfileId,
    bridge.simulatorVersion,
    handlePeerControl,
  );

  // Reenvía a la sesión de red cada valor NUEVO que aparece en el bridge
  // local (un switch/eje que este piloto tocó, o que el propio simulador
  // reportó) -- salvo que sea el eco de algo que acabamos de aplicar porque
  // vino del compañero (ver suppressEchoRef arriba).
  const prevControlsRef = useRef(bridge.controls);
  useEffect(() => {
    const prev = prevControlsRef.current;
    prevControlsRef.current = bridge.controls;
    if (!connected || !joinCode || !pilotName) return;

    for (const [controlId, entry] of Object.entries(bridge.controls)) {
      if (prev[controlId]?.updatedAt === entry.updatedAt) continue; // sin cambios desde el último render

      const suppressed = suppressEchoRef.current.get(controlId);
      if (suppressed && suppressed.value === entry.value) {
        if (Date.now() < suppressed.until) {
          continue; // eco del compañero, no reenviar
        }
        suppressEchoRef.current.delete(controlId); // expiró, ya no aplica
      }

      sendToSession({
        type: entry.channel === "event" ? "control.event" : "control.axis",
        sessionId: joinCode,
        controlId,
        value: entry.value,
        source: pilotName,
        sequence: Date.now(),
        timestamp: Date.now(),
      } as ControlEvent | ControlAxis);
    }
  }, [bridge.controls, connected, joinCode, pilotName, sendToSession]);
  const { ipv4, ipv6 } = usePublicIp();
  const { profiles } = useAircraftProfiles();
  const [ipBlurred, setIpBlurred] = useState(true);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [closingSession, setClosingSession] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);
  const ipStyle = { filter: ipBlurred ? "blur(4px)" : "none" };

  useEffect(() => {
    if (sessionClosed) onSessionClosed?.();
  }, [sessionClosed, onSessionClosed]);

  async function handleCloseSession() {
    if (!joinCode || !pilotName) return;
    setClosingSession(true);
    setCloseError(null);
    try {
      await closeSession(joinCode, pilotName);
      setConfirmCloseOpen(false);
      onSessionClosed?.();
    } catch {
      setCloseError("No se pudo cerrar la sesión. Inténtalo nuevamente.");
    } finally {
      setClosingSession(false);
    }
  }

  async function handleLeaveSession() {
    if (!joinCode || !pilotName) return;
    setSessionActionBusy(true);
    setSessionActionError(null);
    try {
      await leaveSession(joinCode, pilotName);
      onSessionClosed?.();
    } catch {
      setSessionActionError("Could not leave the session. Please try again.");
    } finally {
      setSessionActionBusy(false);
    }
  }

  async function handleControlAction(action: "request" | "give") {
    if (!joinCode || !pilotName) return;
    setSessionActionBusy(true);
    setSessionActionError(null);
    try {
      if (action === "request") await requestControls(joinCode, pilotName);
      else await giveControls(joinCode, pilotName);
    } catch {
      setSessionActionError("The control transfer could not be completed.");
    } finally {
      setSessionActionBusy(false);
    }
  }

  if (!joinCode || !pilotName) {
    return (
      <div className="section" style={{ paddingTop: 24, paddingBottom: 32 }}>
        <div className="section-head section-top" style={{ marginBottom: 6, paddingTop: 16 }}>
          <h2 className="h2-modal">In cockpit</h2>
        </div>
        <p className="lead-sm" style={{ maxWidth: 560 }}>
          You're not in a session yet. Create or join a party first.
        </p>
      </div>
    );
  }

  const aircraft = session ? profiles.find((p) => p.id === session.aircraftProfileId) : undefined;
  const isCreator = session?.creatorPilotName === pilotName;
  const localParticipant = session?.participants.find((p) => p.pilot_name === pilotName);
  const isObserver = localParticipant?.seat === "observer";
  const hasControls = !!localParticipant && session?.controlOwner === localParticipant.seat;
  const remotePilotNames = new Set(
    session?.participants
      .filter((participant) => participant.pilot_name !== pilotName && participant.seat !== "observer")
      .map((participant) => participant.pilot_name) ?? []
  );
  const remotePilotAircraft = Object.entries(peerAircraft).find(([name]) =>
    remotePilotNames.has(name)
  )?.[1];
  const aircraftMismatch =
    !!localProfileId &&
    (!!remotePilotAircraft
      ? remotePilotAircraft.profileId !== localProfileId
      : localProfileId !== session?.aircraftProfileId);
  const simulatorMismatch =
    !!bridge.simulatorVersion &&
    (!!remotePilotAircraft?.simulatorVersion
      ? remotePilotAircraft.simulatorVersion !== bridge.simulatorVersion
      : bridge.simulatorVersion !== session?.sim);

  return (
    <div className="section" style={{ paddingTop: 24, paddingBottom: 32 }}>
      <div className="section-head section-top" style={{ marginBottom: 6, paddingTop: 16 }}>
        <h2 className="h2-modal">In cockpit</h2>
        <button
          className="btn"
          onClick={isCreator ? () => setConfirmCloseOpen(true) : handleLeaveSession}
          disabled={closingSession || sessionActionBusy}
          style={{
            marginLeft: "auto",
            background: "#e24c4b",
            borderColor: "#e24c4b",
            padding: "7px 14px",
          }}
        >
          {isCreator
            ? closingSession ? "Closing…" : "Close party"
            : sessionActionBusy ? "Leaving…" : "Leave session"}
        </button>
      </div>
      <p className="lead-sm" style={{ maxWidth: 560, marginBottom: 22, fontSize: 13 }}>
        Live status while you're flying together — {session?.sessionName ?? joinCode}.
      </p>

      <div
        className="connected-banner"
        style={!connected ? { borderColor: "rgba(226,76,75,0.3)", background: "rgba(226,76,75,0.06)" } : undefined}
      >
        <span className="connected-dot" style={!connected ? { background: "#e24c4b" } : undefined} />
        <span className="connected-label" style={!connected ? { color: "#e24c4b" } : undefined}>
          {connected ? "Connected" : "Disconnected"}
        </span>
        <span className="connected-desc">
          {connected
            ? `${session?.participants.length ?? 0} pilot(s) in this session`
            : "Reconnecting to the session server…"}
        </span>
      </div>

      {(aircraftMismatch || simulatorMismatch) && (
        <div
          className="connected-banner"
          style={{
            borderColor: "rgba(226,182,76,0.45)",
            background: "rgba(226,182,76,0.08)",
            marginTop: 12,
          }}
        >
          <span className="connected-dot" style={{ background: "#e2b64c" }} />
          <span className="connected-label" style={{ color: "#e2b64c" }}>Setup mismatch</span>
          <span className="connected-desc">
            {aircraftMismatch && simulatorMismatch
              ? "The pilots are using different aircraft and simulator versions. Match both before continuing."
              : aircraftMismatch
                ? "The pilots are using different aircraft. Match them before continuing."
                : "The pilots are using different simulator versions. Match them before continuing."}
          </span>
        </div>
      )}

      {!aircraftMismatch && !simulatorMismatch && localProfileId && remotePilotAircraft && (
        <div className="connected-banner" style={{ marginTop: 12 }}>
          <span className="connected-dot" />
          <span className="connected-label">Aircraft matched</span>
          <span className="connected-desc">Both pilots are using the same aircraft and simulator version.</span>
        </div>
      )}

      {sessionActionError && (
        <div style={{ color: "#e24c4b", fontSize: 13, marginTop: 12 }}>{sessionActionError}</div>
      )}

      <div className="grid-2">
        <div>
          <div className="mono-label" style={{ marginBottom: 14 }}>
            Seats
          </div>
          {(session?.participants ?? []).map((p) => (
            <div className="seat-row" key={p.pilot_name}>
              <div className="seat-name">
                {p.pilot_name} — {SEAT_LABEL[p.seat] ?? p.seat}
              </div>
              <div className="seat-status">
                <span
                  className="status-dot"
                  style={{ background: p.pilot_name === pilotName ? "#4ade80" : "rgba(199,248,254,0.5)" }}
                />
                <span
                  className="status-label"
                  style={{ color: p.pilot_name === pilotName ? "#4ade80" : "rgba(199,248,254,0.5)" }}
                >
                  {p.pilot_name === pilotName ? "You" : "Connected"}
                </span>
              </div>
            </div>
          ))}
          {session && session.participants.length < 2 && (
            <div style={{ fontSize: 13, color: "var(--text-45)", padding: "10px 0" }}>
              Waiting for a second pilot to join with code {session.joinCode}…
            </div>
          )}
          <div style={{ marginTop: 22 }}>
            <div className="mono-label" style={{ marginBottom: 10 }}>Flight controls</div>
            <div className="net-row">
              <div className="net-label">Currently flying</div>
              <div className="net-value" style={{ color: "var(--accent)" }}>
                {seatOwnerLabel(session?.controlOwner ?? null, session?.participants ?? [])}
              </div>
            </div>
            {!isObserver && hasControls && session?.controlRequestedBy && (
              <button
                className="btn"
                onClick={() => handleControlAction("give")}
                disabled={sessionActionBusy || aircraftMismatch || simulatorMismatch}
                style={{ marginTop: 12 }}
              >
                Give controls to {seatOwnerLabel(session.controlRequestedBy, session.participants)}
              </button>
            )}
            {!isObserver && !hasControls && (
              <button
                className="btn"
                onClick={() => handleControlAction("request")}
                disabled={
                  sessionActionBusy ||
                  aircraftMismatch ||
                  simulatorMismatch ||
                  (!!localParticipant && session?.controlRequestedBy === localParticipant.seat)
                }
                style={{ marginTop: 12 }}
              >
                {!!localParticipant && session?.controlRequestedBy === localParticipant.seat
                  ? "Controls requested"
                  : "Request controls"}
              </button>
            )}
          </div>
        </div>

        <div>
          <div className="mono-label" style={{ marginBottom: 14 }}>
            Connection
          </div>
          <div className="net-row">
            <div className="net-label">Ping</div>
            <div className="net-value" style={{ color: "var(--accent)" }}>
              {pingMs !== null ? `${pingMs}ms` : "measuring…"}
            </div>
          </div>
          <div className="net-row">
            <div className="net-label">Session status</div>
            <div className="net-value" style={{ color: session?.status === "active" ? "var(--green)" : "var(--accent)" }}>
              {session?.status === "active" ? "Active" : "Waiting for pilots"}
            </div>
          </div>
          <div className="net-row">
            <div className="net-label">Aircraft</div>
            <div className="net-value">{aircraft?.name ?? session?.aircraftProfileId ?? "—"}</div>
          </div>
          <div className="net-row">
            <div className="net-label">Sim</div>
            <div className="net-value">
              {session?.sim === "msfs2024"
                ? "Microsoft Flight Simulator 2024"
                : session?.sim === "msfs2020"
                  ? "Microsoft Flight Simulator 2020"
                  : "—"}
            </div>
          </div>

          <div className="divider-row" style={{ marginTop: 24, marginBottom: 10, border: "none" }}>
            <div className="mono-label">Network</div>
            <button className="link-action" onClick={() => setIpBlurred((v) => !v)}>
              {ipBlurred ? "Show" : "Hide"}
            </button>
          </div>
          <div className="net-row">
            <div className="net-label">IPv4</div>
            <div className="net-value" style={ipStyle}>
              {ipv4}
            </div>
          </div>
          <div className="net-row">
            <div className="net-label">IPv6</div>
            <div className="net-value" style={ipStyle}>
              {ipv6}
            </div>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 32 }}>
        <div
          className="divider-row"
          style={{ marginBottom: 10, border: "none", display: "flex", alignItems: "center", gap: 8 }}
        >
          <div className="mono-label">Aircraft telemetry</div>
          {bridge.mode === "mock" && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                letterSpacing: "0.08em",
                color: "#e2b64c",
                border: "1px solid rgba(226,182,76,0.4)",
                background: "rgba(226,182,76,0.08)",
                padding: "1px 6px",
                textTransform: "uppercase",
              }}
            >
              Mock data
            </span>
          )}
        </div>

        {bridge.connectionState !== "connected" && (
          <p style={{ fontSize: 12, color: "var(--text-35)" }}>
            {bridge.connectionState === "connecting" &&
              (bridge.mode === "mock"
                ? "Connecting to mock simulator-bridge…"
                : "Connecting to simulator-bridge (ws://localhost:7620)…")}
            {bridge.connectionState === "no-bridge-running" &&
              "Aircraft telemetry: no simulator-bridge connection — start apps/simulator-bridge with MSFS running to see live controls here."}
            {bridge.connectionState === "disconnected" &&
              "Aircraft telemetry: lost connection to simulator-bridge — retrying…"}
          </p>
        )}

        {bridge.connectionState === "connected" && (
          <>
            <p style={{ fontSize: 12, color: "var(--text-35)", marginBottom: 10 }}>
              {bridge.mode === "mock"
                ? "Simulated control values for UI development — not connected to a real simulator."
                : `Live from apps/simulator-bridge${bridge.snapshot ? ` — profile ${bridge.snapshot.profile}` : ""}.`}
            </p>
            {Object.keys(bridge.controls).length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--text-45)", padding: "10px 0" }}>
                Connected — waiting for the first control value…
              </div>
            ) : (
              Object.values(bridge.controls)
                .sort((a, b) => a.controlId.localeCompare(b.controlId))
                .map((c) => (
                  <div className="net-row" key={c.controlId}>
                    <div className="net-label">{c.controlId}</div>
                    <div className="net-value">{String(c.value)}</div>
                  </div>
                ))
            )}
          </>
        )}
      </div>

      {confirmCloseOpen && (
        <div className="modal-overlay">
          <div className="update-card" role="alertdialog" aria-modal="true" aria-labelledby="close-session-title">
            <h2 id="close-session-title" className="h2-modal" style={{ marginBottom: 12 }}>
              ¿Cerrar la sesión?
            </h2>
            <p style={{ color: "var(--text-55)", fontSize: 13, lineHeight: 1.6, marginBottom: 22 }}>
              Todos los pilotos serán desconectados y el código de la party dejará de funcionar.
            </p>
            {closeError && (
              <div style={{ color: "#e24c4b", fontSize: 13, marginBottom: 14 }}>{closeError}</div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button
                className="btn"
                onClick={() => setConfirmCloseOpen(false)}
                disabled={closingSession}
                style={{ background: "transparent", color: "var(--text-65)", border: "1px solid var(--hairline)" }}
              >
                Cancelar
              </button>
              <button
                className="btn"
                onClick={handleCloseSession}
                disabled={closingSession}
                style={{ background: "#e24c4b", borderColor: "#e24c4b" }}
              >
                {closingSession ? "Cerrando…" : "Sí, cerrar sesión"}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
