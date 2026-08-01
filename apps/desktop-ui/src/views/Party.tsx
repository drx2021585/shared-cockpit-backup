import { useState } from "react";
import { useAircraftProfiles } from "../lib/useAircraftProfiles";
import { createSession, fetchServerHealth, ApiError, type Session } from "../lib/apiClient";
import { getRelayConfig } from "../lib/relayConfig";

interface PartyProps {
  pilotName: string;
  onPilotNameChange: (name: string) => void;
  createdSession: Session | null;
  onSessionCreated: (session: Session, pilotName: string) => void;
  onSessionReady: (session: Session, pilotName: string) => void;
}

export function Party({
  pilotName,
  onPilotNameChange,
  createdSession,
  onSessionCreated,
  onSessionReady,
}: PartyProps) {
  const { profiles, loading: loadingProfiles } = useAircraftProfiles();
  const relayConfig = getRelayConfig();
  const customRelayUrl = relayConfig.mode === "custom" ? relayConfig.customUrl : null;
  const customRelayHost = customRelayUrl ? (() => {
    try {
      return new URL(customRelayUrl).host;
    } catch {
      return customRelayUrl;
    }
  })() : null;

  const [sessionName, setSessionName] = useState("Afternoon flight");
  const [aircraftProfileId, setAircraftProfileId] = useState<string>("");
  const [sim, setSim] = useState<"msfs2020" | "msfs2024">("msfs2020");
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [seat, setSeat] = useState<"captain" | "first_officer" | "observer">("captain");
  const [joinCodeBlurred, setJoinCodeBlurred] = useState(true);
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
          {customRelayUrl && (
            <div
              style={{
                border: "1px solid var(--hairline)",
                background: "rgba(255,255,255,0.03)",
                padding: 14,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div className="mono-label">Direct host checklist</div>
              <div style={{ fontSize: 12, color: "var(--text-70)" }}>
                This party will use your own relay at <span className="mono">{customRelayUrl}</span>.
              </div>
              <div style={{ fontSize: 12, color: "var(--text-35)" }}>
                Before your friend joins from another network, make sure:
              </div>
              <div style={{ fontSize: 12, color: "var(--text-70)", display: "flex", flexDirection: "column", gap: 6 }}>
                <div>1. The local direct host is running in Profile -&gt; My own relay.</div>
                <div>2. Your router forwards the same TCP port from the internet to this PC.</div>
                <div>3. Your friend uses the same relay URL: <span className="mono">{customRelayUrl}</span>.</div>
                <div>4. If they cannot reach it, test that <span className="mono">{customRelayHost}</span> is really your current public address.</div>
              </div>
            </div>
          )}
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
          </div>
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


          {createdSession && (
            <div style={{ marginBottom: 16 }}>
              <button className="btn" onClick={() => onSessionReady(createdSession, pilotName)}>
                Get in cockpit
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
