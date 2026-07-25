import { useSessionSocket } from "../lib/useSessionSocket";
import { usePublicIp } from "../lib/useNetworkInfo";
import { useAircraftProfiles } from "../lib/useAircraftProfiles";
import { useSimulatorBridge } from "../lib/bridgeClient";
import { useState } from "react";

interface CockpitProps {
  joinCode: string | null;
  pilotName: string | null;
}

const SEAT_LABEL: Record<string, string> = {
  captain: "Captain",
  first_officer: "First officer",
  observer: "Observer",
};

export function Cockpit({ joinCode, pilotName }: CockpitProps) {
  const { connected, session, pingMs } = useSessionSocket(joinCode, pilotName);
  const { ipv4, ipv6 } = usePublicIp();
  const { profiles } = useAircraftProfiles();
  const bridge = useSimulatorBridge();
  const [ipBlurred, setIpBlurred] = useState(true);
  const ipStyle = { filter: ipBlurred ? "blur(4px)" : "none" };

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

  return (
    <div className="section" style={{ paddingTop: 24, paddingBottom: 32 }}>
      <div className="section-head section-top" style={{ marginBottom: 6, paddingTop: 16 }}>
        <h2 className="h2-modal">In cockpit</h2>
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
            ? `Live over WebSocket — ${session?.participants.length ?? 0} pilot(s) in this session`
            : "Reconnecting to the session server…"}
        </span>
      </div>

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
    </div>
  );
}
