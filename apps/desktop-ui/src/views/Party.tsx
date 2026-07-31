import { useState } from "react";
import { useAircraftProfiles } from "../lib/useAircraftProfiles";
import { usePublicIp } from "../lib/useNetworkInfo";
import { createSession, fetchServerHealth, ApiError, type Session } from "../lib/apiClient";
import { buildDirectInviteCode } from "../lib/directInviteCode";
import { type RelayConfig } from "../lib/relayConfig";

interface PartyProps {
  pilotName: string;
  onPilotNameChange: (name: string) => void;
  createdSession: Session | null;
  onSessionCreated: (session: Session, pilotName: string) => void;
  onSessionReady: (session: Session, pilotName: string) => void;
  relayConfig: RelayConfig;
  onRelayConfigChange: (config: RelayConfig) => void;
}

export function Party({
  pilotName,
  onPilotNameChange,
  createdSession,
  onSessionCreated,
  onSessionReady,
  relayConfig,
  onRelayConfigChange,
}: PartyProps) {
  const { ipv4, ipv6 } = usePublicIp();
  const { profiles, loading: loadingProfiles } = useAircraftProfiles();

  const [sessionName, setSessionName] = useState("Afternoon flight");
  const [aircraftProfileId, setAircraftProfileId] = useState<string>("");
  const [sim, setSim] = useState<"msfs2020" | "msfs2024">("msfs2020");
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [seat, setSeat] = useState<"captain" | "first_officer" | "observer">("captain");
  const [joinCodeBlurred, setJoinCodeBlurred] = useState(true);
  const [ipBlurred, setIpBlurred] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const compatibleProfiles = profiles.filter(
    (profile) => profile.availability !== "soon" && profile.compatibility[sim]
  );
  const selectedProfileIsCompatible = compatibleProfiles.some(
    (profile) => profile.id === aircraftProfileId
  );
  const effectiveProfileId =
    (selectedProfileIsCompatible ? aircraftProfileId : compatibleProfiles[0]?.id) || "";
  const joinCodeStyle = { filter: joinCodeBlurred ? "blur(4px)" : "none" };
  const ipStyle = { filter: ipBlurred ? "blur(4px)" : "none" };
  const relayPort = (() => {
    if (relayConfig.mode !== "self-hosted") return 8787;
    try {
      const url = new URL(relayConfig.customBaseUrl);
      return Number(url.port || (url.protocol === "https:" ? 443 : 80));
    } catch {
      return 8787;
    }
  })();
  const directInviteCode =
    createdSession && relayConfig.mode === "self-hosted" && ipv4 !== "Unavailable" && ipv4 !== "Detecting…"
      ? buildDirectInviteCode({ host: ipv4, port: relayPort, joinCode: createdSession.joinCode })
      : null;

  async function createParty() {
    if (!pilotName.trim()) {
      setError("Enter your pilot name first.");
      return false;
    }
    if (!effectiveProfileId) {
      setError("No aircraft profile available to fly.");
      return false;
    }
    try {
      const session = await createSession({
        sessionName,
        aircraftProfileId: effectiveProfileId,
        password: usePassword ? password : undefined,
        hostPilotName: pilotName.trim(),
        hostSeat: seat,
        sim,
      });
      onSessionCreated(session, pilotName.trim());
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? `Could not create session: ${err.code}` : "Could not reach the server.");
      return false;
    }
  }

  async function handleCreate() {
    setSubmitting(true);
    setError(null);
    try {
      await createParty();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCreateDirect() {
    if (ipv4 === "Unavailable" || ipv4 === "Detecting…") {
      setError("Local IPv4 is not available on this PC yet.");
      return;
    }
    const directBaseUrl = `http://${ipv4}:8787`;
    setSubmitting(true);
    setError(null);
    try {
      await fetchServerHealth(directBaseUrl);
      onRelayConfigChange({ mode: "self-hosted", customBaseUrl: directBaseUrl });
      await createParty();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(`Direct host could not start the session: ${err.code}`);
      } else {
        setError("Direct host is not running on this PC. Start server/api with `npm run dev:direct` and try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="section" style={{ paddingTop: 24, paddingBottom: 32 }}>
      <div className="section-head" style={{ marginBottom: 6, paddingTop: 16 }}>
        <h2 className="h2-modal">Create a party</h2>
      </div>
      <p className="lead-sm" style={{ maxWidth: 560, marginBottom: 22, fontSize: 13 }}>
        Set up your flight and share the code with your friend.
      </p>

      <div className="grid-2">
        <div style={{ maxWidth: 420, display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="field">
            <label>Your pilot name</label>
            <input
              type="text"
              placeholder="Enter your name"
              value={pilotName}
              onChange={(e) => onPilotNameChange(e.target.value)}
            />
          </div>

          <div className="field">
            <label>Session name</label>
            <input type="text" value={sessionName} onChange={(e) => setSessionName(e.target.value)} />
          </div>

          <div className="field">
            <label>Aircraft</label>
            {loadingProfiles ? (
              <div style={{ fontSize: 13, color: "var(--text-45)", padding: "6px 0" }}>Loading…</div>
            ) : compatibleProfiles.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--text-45)", padding: "6px 0" }}>
                No aircraft profiles are currently available for this simulator.
              </div>
            ) : (
              <select value={effectiveProfileId} onChange={(e) => setAircraftProfileId(e.target.value)}>
                {compatibleProfiles.map((ac) => (
                  <option key={ac.id} value={ac.id}>
                    {ac.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="field">
            <label>Sim</label>
            <select value={sim} onChange={(e) => setSim(e.target.value as "msfs2020" | "msfs2024")}>
              <option value="msfs2020">Microsoft Flight Simulator 2020</option>
              <option value="msfs2024">Microsoft Flight Simulator 2024</option>
            </select>
          </div>

          <button
            className="checkbox-row"
            onClick={() => setUsePassword((v) => !v)}
            aria-pressed={usePassword}
          >
            <span className="checkbox-box">{usePassword ? "✓" : ""}</span>
            <span className="checkbox-label">Use a password</span>
          </button>

          {usePassword && (
            <div className="field">
              <label>Password</label>
              <input type="password" placeholder="••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          )}

          <div className="field">
            <label>Your seat</label>
            <div className="seat-toggle">
              <button
                className={`seat-option ${seat === "captain" ? "active" : ""}`}
                onClick={() => setSeat("captain")}
              >
                Captain
              </button>
              <button
                className={`seat-option ${seat === "first_officer" ? "active" : ""}`}
                onClick={() => setSeat("first_officer")}
              >
                First officer
              </button>
              <button
                className={`seat-option ${seat === "observer" ? "active" : ""}`}
                onClick={() => setSeat("observer")}
              >
                Observer
              </button>
            </div>
            <p style={{ color: "var(--text-45)", fontSize: 12, marginTop: 8 }}>
              Flight controls can only be transferred between the captain and the first officer.
            </p>
            {seat === "observer" && (
              <p style={{ color: "var(--text-45)", fontSize: 12, marginTop: 8 }}>
                You'll join without flying. Controls start on the captain's seat, so
                whoever joins as captain gets them.
              </p>
            )}
          </div>

          {error && <div style={{ color: "#e24c4b", fontSize: 13 }}>{error}</div>}

          <div style={{ paddingTop: 6, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <button className="btn" onClick={handleCreate} disabled={submitting || createdSession !== null}>
              {submitting ? "Creating…" : "Create session"}
            </button>
            <button className="link-action" onClick={handleCreateDirect} disabled={submitting || createdSession !== null}>
              {submitting ? "Starting direct host…" : "Host direct session"}
            </button>
          </div>
          <p style={{ color: "var(--text-45)", fontSize: 12, marginTop: 2 }}>
            Direct mode uses this PC as the relay host and prepares a direct invite code for the other pilot.
          </p>
          <p style={{ color: "var(--text-45)", fontSize: 12, marginTop: -8 }}>
            Expected local host: {ipv4 === "Unavailable" || ipv4 === "Detecting…" ? "unavailable" : `http://${ipv4}:8787`}
          </p>
        </div>

        <div>
          <div className="divider-row" style={{ marginBottom: 10, border: "none" }}>
            <div className="mono-label">Code for your friend</div>
            <button className="link-action" onClick={() => setJoinCodeBlurred((value) => !value)}>
              {joinCodeBlurred ? "Show" : "Hide"}
            </button>
          </div>
          <div className="code-box">
            <div className="code-value" style={joinCodeStyle}>
              {createdSession?.joinCode ?? "— — — —"}
            </div>
            <div className="code-caption">
              {createdSession
                ? "Share this code so they can join your cockpit"
                : "Create the session to generate a real code"}
            </div>
          </div>

          {directInviteCode && (
            <>
              <div className="divider-row" style={{ marginTop: 18, marginBottom: 10, border: "none" }}>
                <div className="mono-label">Direct invite code</div>
              </div>
              <div className="code-box">
                <div className="code-caption" style={{ marginBottom: 10 }}>
                  Paste this on the other PC and We Connect will route itself to this host automatically.
                </div>
                <div className="code-value" style={{ fontSize: 12, letterSpacing: "0.04em", wordBreak: "break-all" }}>
                  {directInviteCode}
                </div>
              </div>
            </>
          )}

          {createdSession && (
            <div style={{ marginBottom: 16 }}>
              <button className="btn" onClick={() => onSessionReady(createdSession, pilotName)}>
                Get in cockpit
              </button>
            </div>
          )}

          <div className="divider-row" style={{ marginBottom: 10, border: "none" }}>
            <div className="mono-label">Network</div>
            <button className="link-action" onClick={() => setIpBlurred((v) => !v)}>
              {ipBlurred ? "Show" : "Hide"}
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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
      </div>
    </div>
  );
}
