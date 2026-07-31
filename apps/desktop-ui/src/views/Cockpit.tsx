import { useSessionSocket } from "../lib/useSessionSocket";
import { usePublicIp } from "../lib/useNetworkInfo";
import { useAircraftProfiles } from "../lib/useAircraftProfiles";
import {
  MIN_SUPPORTED_BRIDGE_API_VERSION,
  replaceStaleBridge,
  useSimulatorBridge,
  type BridgeScreenSnapshot,
} from "../lib/bridgeClient";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  closeSession,
  leaveSession,
  requestControls,
  giveControls,
  type Session,
  type SessionParticipant,
} from "../lib/apiClient";
import type { ControlAxis, ControlEvent, FlightPose, ScreenSnapshot } from "../../../../packages/protocol/types";
import { recordPeerControl, recordSessionEvent, resetSessionJournal } from "../lib/sessionJournal";
import { downloadDiagnosticsReport } from "../lib/diagnosticsReport";
import { currentVersion } from "../data";

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
const STALE_NETWORK_MS = 12_000;
const STALE_FLIGHT_DATA_MS = 5_000;
const STALE_SCREEN_MS = 8_000;
const POSE_SEND_INTERVAL_MS = 100;

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

const CDU_COLOR: Record<number, string> = {
  0: "#f3f8fb",
  1: "#67e8f9",
  2: "#4ade80",
  3: "#e879f9",
  4: "#fbbf24",
  5: "#f87171",
};

function screenLabel(screenId: string) {
  if (screenId === "cdu_captain") return "Captain CDU";
  if (screenId === "cdu_fo") return "First officer CDU";
  return screenId.replace(/_/g, " ");
}

function renderScreenCells(rows: number, cols: number, cells: ScreenSnapshot["cells"]) {
  const total = rows * cols;
  const normalized = Array.from({ length: total }, (_, index) => cells[index] ?? { char: " ", colorId: 0, flags: 0 });
  return normalized.map((cell, index) => {
    const isSmall = (cell.flags & 0x01) !== 0;
    const isReverse = (cell.flags & 0x02) !== 0;
    const color = CDU_COLOR[cell.colorId] ?? CDU_COLOR[0];
    const char = cell.char && cell.char.length > 0 ? cell.char[0] : " ";
    return (
      <span
        key={index}
        className={`cdu-cell${isSmall ? " cdu-cell-small" : ""}${isReverse ? " cdu-cell-reverse" : ""}`}
        style={
          isReverse
            ? { color: "#0a0a0a", background: color }
            : { color }
        }
      >
        {char}
      </span>
    );
  });
}

function ScreenPanel({
  title,
  subtitle,
  screen,
}: {
  title: string;
  subtitle: string;
  screen: { rows: number; cols: number; cells: ScreenSnapshot["cells"]; powered?: boolean | null; revision: number };
}) {
  const powered = screen.powered ?? true;
  return (
    <div className="cdu-panel">
      <div className="cdu-panel-head">
        <div>
          <div className="cdu-panel-title">{title}</div>
          <div className="cdu-panel-subtitle">{subtitle}</div>
        </div>
        <div className="cdu-panel-meta">rev {screen.revision}</div>
      </div>
      <div className={`cdu-screen${powered ? "" : " cdu-screen-off"}`}>
        {powered ? (
          <div
            className="cdu-grid"
            style={{ gridTemplateColumns: `repeat(${screen.cols}, minmax(0, 1fr))` }}
          >
            {renderScreenCells(screen.rows, screen.cols, screen.cells)}
          </div>
        ) : (
          <div className="cdu-screen-off-label">Display off</div>
        )}
      </div>
    </div>
  );
}

function pilotSeatLabel(pilotName: string, participants: SessionParticipant[]) {
  const participant = participants.find((p) => p.pilot_name === pilotName);
  return participant ? (SEAT_LABEL[participant.seat] ?? participant.seat) : "Pilot";
}

function healthTone(status: "ok" | "warn" | "bad") {
  if (status === "ok") return { color: "var(--green)", dot: "#4ade80" };
  if (status === "warn") return { color: "#fbbf24", dot: "#fbbf24" };
  return { color: "#e24c4b", dot: "#e24c4b" };
}

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

function formatSimLabel(sim: "msfs2020" | "msfs2024" | null | undefined) {
  if (sim === "msfs2024") return "Microsoft Flight Simulator 2024";
  if (sim === "msfs2020") return "Microsoft Flight Simulator 2020";
  return "Unknown";
}

function normalizeText(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
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
      // Se anota ANTES de aplicarlo: el reporte necesita saber qué llegó del otro
      // piloto y cuándo, para poder distinguir "no me llegó nunca" de "me llegó y
      // mi bridge no lo pudo aplicar" -- dos fallos completamente distintos que sin
      // esto se ven igual. Va a un módulo con estado mutable, no a useState: los
      // control.axis llegan a 20-60Hz y un re-render por muestra tiraría el
      // rendimiento de la cabina (ver lib/sessionJournal.ts).
      recordPeerControl(msg.controlId, msg.type === "control.axis" ? "axis" : "event", msg.value);
      bridge.send(msg);
    },
    [bridge],
  );

  const handlePeerPose = useCallback(
    (msg: FlightPose) => {
      bridge.send(msg);
    },
    [bridge],
  );

  const {
    connected,
    session,
    pingMs,
    sessionClosed,
    lastPongAt,
    lastPeerControlAt,
    lastPeerAircraftAt,
    lastPeerPoseAt,
    lastPeerScreenAt,
    peerAircraft,
    peerScreens,
    send: sendToSession,
  } = useSessionSocket(
    joinCode,
    pilotName,
    initialSession,
    localProfileId,
    bridge.simulatorVersion,
    handlePeerControl,
    handlePeerPose,
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

  const prevScreensRef = useRef(bridge.screens);
  useEffect(() => {
    const prev = prevScreensRef.current;
    prevScreensRef.current = bridge.screens;
    if (!connected || !joinCode) return;

    for (const [screenId, screen] of Object.entries(bridge.screens)) {
      if (prev[screenId]?.updatedAt === screen.updatedAt) continue;

      sendToSession({
        type: "screen.snapshot",
        sessionId: joinCode,
        screenId,
        rows: screen.rows,
        cols: screen.cols,
        cells: screen.cells,
        powered: screen.powered ?? undefined,
        revision: screen.revision,
        timestamp: Date.now(),
      } as ScreenSnapshot);
    }
  }, [bridge.screens, connected, joinCode, sendToSession]);

  const previousConnectedRef = useRef(false);
  useEffect(() => {
    const justReconnected = connected && !previousConnectedRef.current;
    previousConnectedRef.current = connected;
    if (!justReconnected || !joinCode || !pilotName) {
      return;
    }

    for (const [controlId, entry] of Object.entries(bridge.controls)) {
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

    for (const [screenId, screen] of Object.entries(bridge.screens)) {
      sendToSession({
        type: "screen.snapshot",
        sessionId: joinCode,
        screenId,
        rows: screen.rows,
        cols: screen.cols,
        cells: screen.cells,
        powered: screen.powered ?? undefined,
        revision: screen.revision,
        timestamp: Date.now(),
      } as ScreenSnapshot);
    }
  }, [bridge.controls, bridge.screens, connected, joinCode, pilotName, sendToSession]);

  const lastSentPoseRef = useRef<{ sequence: number; at: number } | null>(null);
  useEffect(() => {
    if (!connected || !joinCode || !bridge.pose) {
      return;
    }
    const localSeat = session?.participants.find((p) => p.pilot_name === pilotName)?.seat ?? null;
    const localHasFlightAuthority = !!localSeat && session?.controlOwner === localSeat;
    if (!localHasFlightAuthority) {
      return;
    }

    const previous = lastSentPoseRef.current;
    if (previous && previous.sequence === bridge.pose.sequence) {
      return;
    }
    if (previous && bridge.pose.updatedAt - previous.at < POSE_SEND_INTERVAL_MS) {
      return;
    }

    lastSentPoseRef.current = { sequence: bridge.pose.sequence, at: bridge.pose.updatedAt };
    sendToSession({
      ...bridge.pose,
      sessionId: joinCode,
    });
  }, [bridge.pose, connected, joinCode, pilotName, sendToSession, session]);
  // --- Bitácora para el reporte de diagnóstico -------------------------------
  // Una sesión nueva empieza con la bitácora limpia: lo de la anterior no
  // describe nada de esta.
  useEffect(() => {
    resetSessionJournal();
    if (joinCode) recordSessionEvent("note", `Joined session ${joinCode}`);
  }, [joinCode]);

  useEffect(() => {
    recordSessionEvent(connected ? "connected" : "disconnected", `session socket connected=${connected}`);
  }, [connected]);

  // Quién tiene los mandos: un cambio acá explica por qué un eje dejó de aplicarse
  // (authority exclusive), que de otro modo parece un fallo de sincronización.
  const controlOwner = session?.controlOwner ?? null;
  useEffect(() => {
    if (controlOwner) recordSessionEvent("authority", `flight controls owned by seat "${controlOwner}"`);
  }, [controlOwner]);

  useEffect(() => {
    if (sessionClosed) recordSessionEvent("closed", "session was closed");
  }, [sessionClosed]);

  // FSUIPC7 es el requisito real para que se lea/escriba cualquier cabina de
  // payware; su ausencia es la explicación más simple de "no se sincroniza nada" y
  // tiene que constar en el reporte.
  const [fsuipc, setFsuipc] = useState<WeConnectFsuipcStatus | null>(null);
  useEffect(() => {
    window.weconnectSetup?.checkFsuipc().then(setFsuipc).catch(() => setFsuipc(null));
  }, []);

  const [reportFilename, setReportFilename] = useState<string | null>(null);

  const handleDownloadReport = useCallback(() => {
    const name = downloadDiagnosticsReport({
      bridge,
      fsuipc,
      session: {
        joinCode,
        pilotName,
        role: session?.participants.find((p) => p.pilot_name === pilotName)?.seat ?? null,
        connected,
        reconnecting: false,
        pingMs,
        peerAircraft,
      },
      communityPath: null,
    });
    setReportFilename(name);
  }, [bridge, fsuipc, joinCode, pilotName, session, connected, pingMs, peerAircraft]);

  const { ipv4, ipv6 } = usePublicIp();
  const { profiles } = useAircraftProfiles();
  const [ipBlurred, setIpBlurred] = useState(true);
  const [healthNow, setHealthNow] = useState(() => Date.now());
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [aircraftMatchConfirmOpen, setAircraftMatchConfirmOpen] = useState(false);
  const [closingSession, setClosingSession] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);
  const ipStyle = { filter: ipBlurred ? "blur(4px)" : "none" };

  useEffect(() => {
    if (sessionClosed) onSessionClosed?.();
  }, [sessionClosed, onSessionClosed]);

  useEffect(() => {
    const timer = window.setInterval(() => setHealthNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

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
        <div className="section-head" style={{ marginBottom: 6, paddingTop: 16 }}>
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
  const remotePilotScreenEntries = Object.entries(peerScreens).filter(([name]) => remotePilotNames.has(name));
  const localScreenEntries = Object.entries(bridge.screens).sort(([a], [b]) => a.localeCompare(b));
  const hasAnySharedScreens = localScreenEntries.length > 0 || remotePilotScreenEntries.length > 0;
  const now = healthNow;
  const networkHealthy = connected && !!lastPongAt && now - lastPongAt <= STALE_NETWORK_MS;
  const peerFlightDataFresh =
    !!remotePilotAircraft &&
    !!lastPeerAircraftAt &&
    now - lastPeerAircraftAt <= STALE_FLIGHT_DATA_MS;
  const peerPoseFresh =
    !!lastPeerPoseAt &&
    now - lastPeerPoseAt <= STALE_FLIGHT_DATA_MS;
  const peerControlsFresh =
    !!lastPeerControlAt &&
    now - lastPeerControlAt <= STALE_FLIGHT_DATA_MS;
  const peerScreensFresh =
    remotePilotScreenEntries.length === 0 ||
    (!!lastPeerScreenAt && now - lastPeerScreenAt <= STALE_SCREEN_MS);
  const bridgeHealthy =
    bridge.connectionState === "connected" &&
    !!bridge.lastMessageAt &&
    now - bridge.lastMessageAt <= STALE_FLIGHT_DATA_MS;
  const networkStatus = connected ? (networkHealthy ? "ok" : "warn") : "bad";
  const bridgeStatus = bridge.connectionState === "connected" ? (bridgeHealthy ? "ok" : "warn") : "bad";
  const peerDataStatus =
    remotePilotNames.size === 0
      ? "warn"
      : peerFlightDataFresh || peerControlsFresh || peerPoseFresh
        ? "ok"
        : connected
          ? "warn"
          : "bad";
  const sharedScreensStatus =
    remotePilotScreenEntries.length === 0
      ? "warn"
      : peerScreensFresh
        ? "ok"
        : "warn";
  const aircraftMismatch =
    !!localProfileId &&
    (!!remotePilotAircraft
      ? remotePilotAircraft.profileId !== localProfileId
      : localProfileId !== session?.aircraftProfileId);
  const variantMismatch =
    !aircraftMismatch &&
    !!bridge.detectedTitle &&
    !!remotePilotAircraft?.detectedTitle &&
    normalizeText(bridge.detectedTitle) !== normalizeText(remotePilotAircraft.detectedTitle);
  const simulatorMismatch =
    !!bridge.simulatorVersion &&
    (!!remotePilotAircraft?.simulatorVersion
      ? remotePilotAircraft.simulatorVersion !== bridge.simulatorVersion
      : bridge.simulatorVersion !== session?.sim);
  const appVersionMismatch =
    !!remotePilotAircraft?.appVersion &&
    remotePilotAircraft.appVersion !== currentVersion;
  const bridgeCompatibilityError =
    bridge.connectionState === "connected" &&
    (bridge.bridgeApiVersion === null || bridge.bridgeApiVersion < MIN_SUPPORTED_BRIDGE_API_VERSION);
  const setupMismatchReasons = [
    aircraftMismatch ? "aircraft" : null,
    variantMismatch ? "variant" : null,
    simulatorMismatch ? "simulator" : null,
    appVersionMismatch ? "app version" : null,
  ].filter((value): value is string => value !== null);
  const setupMismatch = setupMismatchReasons.length > 0;
  const aircraftMatched =
    !setupMismatch && !!localProfileId && !!remotePilotAircraft;
  const previousAircraftMatchedRef = useRef(false);

  useEffect(() => {
    if (aircraftMatched && !previousAircraftMatchedRef.current) {
      setAircraftMatchConfirmOpen(true);
    }
    if (!aircraftMatched && aircraftMatchConfirmOpen) {
      setAircraftMatchConfirmOpen(false);
    }
    previousAircraftMatchedRef.current = aircraftMatched;
  }, [aircraftMatched, aircraftMatchConfirmOpen]);

  // Un bridge viejo escuchando en ws://localhost:7620 hace que Electron nunca
  // arranque el empaquetado (launchBridgeIfNeeded se rinde si el puerto ya
  // responde, ver electron/main.cjs), así que la app se queda pegada a él y
  // antes el único arreglo era abrir el Task Manager. Se intenta el reemplazo
  // una sola vez por sesión de app; si el banner sigue después de eso, el bridge
  // viejo ES el empaquetado y lo que hace falta es reinstalar la app.
  const [bridgeFixState, setBridgeFixState] = useState<
    "idle" | "working" | "restarted" | "failed" | "unavailable"
  >("idle");
  const bridgeFixAttemptedRef = useRef(false);

  const runBridgeFix = useCallback(async () => {
    setBridgeFixState("working");
    const result = await replaceStaleBridge();
    setBridgeFixState(result === null ? "unavailable" : result.ok ? "restarted" : "failed");
  }, []);

  useEffect(() => {
    if (!bridgeCompatibilityError || bridgeFixAttemptedRef.current) return;
    bridgeFixAttemptedRef.current = true;
    void runBridgeFix();
  }, [bridgeCompatibilityError, runBridgeFix]);

  const bridgeFixMessage =
    bridgeFixState === "working"
      ? " Restarting the bundled bridge…"
      : bridgeFixState === "restarted"
        ? " The bundled bridge was restarted. If this banner stays, this build of the app is shipping an outdated bridge — reinstall the latest release."
        : bridgeFixState === "failed"
          ? " Couldn't restart it automatically. Close SharedCockpit.Bridge.exe from the Task Manager and reopen We Connect."
          : " Close any old manual bridge and reopen We Connect so the bundled bridge starts.";

  return (
    <div className="section" style={{ paddingTop: 24, paddingBottom: 32 }}>
      <div className="section-head" style={{ marginBottom: 6, paddingTop: 16 }}>
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

      {bridgeCompatibilityError && (
        <div
          className="connected-banner"
          style={{
            borderColor: "rgba(226,76,75,0.4)",
            background: "rgba(226,76,75,0.08)",
            marginTop: 12,
          }}
        >
          <span className="connected-dot" style={{ background: "#e24c4b" }} />
          <span className="connected-label" style={{ color: "#e24c4b" }}>Bridge update required</span>
          <span className="connected-desc">
            {`This app requires bridge API ${MIN_SUPPORTED_BRIDGE_API_VERSION} or newer. `}
            {bridge.bridgeApiVersion === null
              ? "Your local bridge is too old to report its compatibility level."
              : `Your local bridge reports API ${bridge.bridgeApiVersion}.`}
            {bridge.bridgeBuildVersion ? ` Build ${bridge.bridgeBuildVersion}.` : ""}
            {bridgeFixMessage}
          </span>
          {bridgeFixState !== "working" && bridgeFixState !== "unavailable" && (
            <button
              className="btn"
              onClick={() => void runBridgeFix()}
              style={{ marginLeft: "auto", padding: "6px 12px", flexShrink: 0 }}
            >
              Restart bridge
            </button>
          )}
        </div>
      )}

      {setupMismatch && (
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
            {`Mismatch found in: ${setupMismatchReasons.join(", ")}. Match both sides before continuing.`}
          </span>
          <div style={{ width: "100%", marginTop: 10, fontSize: 12, color: "var(--text-65)" }}>
            <div><strong>You:</strong> {localProfileId ?? "Unknown aircraft"} · {bridge.detectedTitle ?? "Unknown variant"} · {formatSimLabel(bridge.simulatorVersion)} · v{currentVersion}</div>
            <div><strong>Peer:</strong> {remotePilotAircraft?.profileId ?? session?.aircraftProfileId ?? "Unknown aircraft"} · {remotePilotAircraft?.detectedTitle ?? "Unknown variant"} · {formatSimLabel(remotePilotAircraft?.simulatorVersion ?? session?.sim ?? null)} · v{remotePilotAircraft?.appVersion ?? "Unknown"}</div>
          </div>
        </div>
      )}

      {aircraftMatched && (
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
                disabled={sessionActionBusy || setupMismatch || bridgeCompatibilityError}
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
                  setupMismatch ||
                  bridgeCompatibilityError ||
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

          <div style={{ marginTop: 26 }}>
            <div className="mono-label" style={{ marginBottom: 10 }}>Link health</div>
            {[
              {
                label: "Session relay",
                value: connected ? (networkHealthy ? "Healthy" : "Connected but stale") : "Disconnected",
                status: networkStatus as "ok" | "warn" | "bad",
              },
              {
                label: "Local bridge",
                value:
                  bridge.connectionState === "connected"
                    ? bridgeCompatibilityError
                      ? "Incompatible build"
                      : bridgeHealthy
                      ? "Healthy"
                      : "Connected but stale"
                    : bridge.connectionState === "connecting"
                      ? "Connecting"
                      : bridge.connectionState === "no-bridge-running"
                        ? "Not running"
                        : "Disconnected",
                status: (bridgeCompatibilityError ? "bad" : bridgeStatus) as "ok" | "warn" | "bad",
              },
              {
                label: "Peer flight data",
                value:
                  remotePilotNames.size === 0
                    ? "Waiting for peer"
                    : peerFlightDataFresh || peerControlsFresh || peerPoseFresh
                      ? "Fresh"
                      : "No recent data",
                status: peerDataStatus as "ok" | "warn" | "bad",
              },
              {
                label: "Shared displays",
                value:
                  remotePilotScreenEntries.length === 0
                    ? "No remote screens yet"
                    : peerScreensFresh
                      ? "Fresh"
                      : "Screen feed stale",
                status: sharedScreensStatus as "ok" | "warn" | "bad",
              },
            ].map((item) => {
              const tone = healthTone(item.status);
              return (
                <div className="net-row" key={item.label}>
                  <div className="net-label">{item.label}</div>
                  <div className="net-value" style={{ color: tone.color }}>
                    <span
                      style={{
                        display: "inline-block",
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: tone.dot,
                        marginRight: 8,
                      }}
                    />
                    {item.value}
                  </div>
                </div>
              );
            })}
            <p style={{ fontSize: 11, color: "var(--text-45)", lineHeight: 1.6, marginTop: 10 }}>
              After a reconnect, We Connect now re-publishes your current controls and read-only screens so both
              cabins converge again without waiting for the next manual action.
            </p>
          </div>

          {/* Reporte de diagnóstico. Antes, entender por qué una sesión no
              sincronizaba obligaba a pedirle al usuario que buscara bridge.log en
              %APPDATA% y lo mandara a mano -- un archivo ruidoso que además no
              sabe nada de la sesión ni trae contadores agregados. */}
          <div style={{ marginTop: 26 }}>
            <div className="mono-label" style={{ marginBottom: 10 }}>Diagnostics</div>
            <div className="net-row">
              <div className="net-label">Sync problems logged</div>
              <div
                className="net-value"
                style={{ color: (bridge.diagnostics?.errorsReported ?? 0) > 0 ? "#fbbf24" : "var(--green)" }}
              >
                {bridge.diagnostics?.errorsReported ?? 0}
              </div>
            </div>
            {bridge.diagnostics && (
              <div className="net-row">
                <div className="net-label">Switches applied / failed</div>
                <div className="net-value">
                  {bridge.diagnostics.writesConfirmed} / {bridge.diagnostics.writesFailed}
                </div>
              </div>
            )}
            {(bridge.diagnostics?.polarityInversionsLearned ?? 0) > 0 && (
              <div className="net-row">
                <div className="net-label">Controls auto-corrected</div>
                <div className="net-value" style={{ color: "var(--accent)" }}>
                  {bridge.diagnostics?.polarityInversionsLearned}
                </div>
              </div>
            )}
            <button className="btn" onClick={handleDownloadReport} style={{ marginTop: 12 }}>
              Download report
            </button>
            <p style={{ fontSize: 11, color: "var(--text-45)", lineHeight: 1.6, marginTop: 10 }}>
              {reportFilename
                ? `Saved ${reportFilename}. Send it over along with your co-pilot's — a report from each side is what makes a sync problem diagnosable.`
                : "Saves everything needed to diagnose a sync problem: bridge errors, what arrived from your co-pilot, and your FSUIPC7 status. Both pilots should download one."}
            </p>
          </div>

          {hasAnySharedScreens && (
            <div style={{ marginTop: 26 }}>
              <div className="mono-label" style={{ marginBottom: 10 }}>Shared displays</div>
              <div className="cdu-wall">
                {localScreenEntries.map(([screenId, screen]) => (
                  <ScreenPanel
                    key={`local:${screenId}`}
                    title={screenLabel(screenId)}
                    subtitle="Your bridge"
                    screen={screen}
                  />
                ))}
                {remotePilotScreenEntries.flatMap(([remotePilot, screens]) =>
                  Object.entries(screens)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([screenId, screen]) => (
                      <ScreenPanel
                        key={`${remotePilot}:${screenId}`}
                        title={screenLabel(screenId)}
                        subtitle={`${remotePilot} · ${pilotSeatLabel(remotePilot, session?.participants ?? [])}`}
                        screen={screen}
                      />
                    ))
                )}
              </div>
              <p style={{ fontSize: 11, color: "var(--text-45)", lineHeight: 1.6, marginTop: 10 }}>
                Read-only cockpit displays mirrored through `screen.snapshot`. This confirms whether the screen data is
                actually crossing between both PCs.
              </p>
            </div>
          )}
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
          <div className="net-row">
            <div className="net-label">App version</div>
            <div className="net-value">v{currentVersion}</div>
          </div>
          <div className="net-row">
            <div className="net-label">Bridge build</div>
            <div className="net-value">
              {bridge.bridgeBuildVersion
                ? `v${bridge.bridgeBuildVersion} · API ${bridge.bridgeApiVersion ?? "?"}`
                : bridge.bridgeApiVersion !== null
                  ? `API ${bridge.bridgeApiVersion}`
                  : "Unknown"}
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

      {aircraftMatchConfirmOpen && (
        <div className="modal-overlay">
          <div className="update-card" role="alertdialog" aria-modal="true" aria-labelledby="aircraft-match-title">
            <h2 id="aircraft-match-title" className="h2-modal" style={{ marginBottom: 12 }}>
              Avion confirmado
            </h2>
            <p style={{ color: "var(--text-55)", fontSize: 13, lineHeight: 1.6, marginBottom: 22 }}>
              Ambos pilotos estan usando el mismo modelo de avion y la misma version del simulador.
              Tambien coinciden en la variante detectada y la version de la app.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button
                className="btn"
                onClick={() => setAircraftMatchConfirmOpen(false)}
              >
                Continuar
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
