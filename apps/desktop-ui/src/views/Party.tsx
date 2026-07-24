import { useState } from "react";
import { useAircraftProfiles } from "../lib/useAircraftProfiles";
import { usePublicIp } from "../lib/useNetworkInfo";
import { createSession, ApiError, type Session } from "../lib/apiClient";

interface PartyProps {
  pilotName: string;
  onPilotNameChange: (name: string) => void;
  onSessionReady: (session: Session, pilotName: string) => void;
}

export function Party({ pilotName, onPilotNameChange, onSessionReady }: PartyProps) {
  const { ipv4, ipv6 } = usePublicIp();
  const { profiles, loading: loadingProfiles } = useAircraftProfiles();

  const [sessionName, setSessionName] = useState("Afternoon flight");
  const [aircraftProfileId, setAircraftProfileId] = useState<string>("");
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [seat, setSeat] = useState<"captain" | "first_officer">("captain");
  const [ipBlurred, setIpBlurred] = useState(true);
  const [createdSession, setCreatedSession] = useState<Session | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveProfileId = aircraftProfileId || profiles[0]?.id || "";
  const ipStyle = { filter: ipBlurred ? "blur(4px)" : "none" };

  async function handleCreate() {
    if (!pilotName.trim()) {
      setError("Enter your pilot name first.");
      return;
    }
    if (!effectiveProfileId) {
      setError("No aircraft profile available to fly.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const session = await createSession({
        sessionName,
        aircraftProfileId: effectiveProfileId,
        password: usePassword ? password : undefined,
        hostPilotName: pilotName.trim(),
        hostSeat: seat,
      });
      setCreatedSession(session);
    } catch (err) {
      setError(err instanceof ApiError ? `Could not create session: ${err.code}` : "Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="section" style={{ paddingTop: 24, paddingBottom: 32 }}>
      <div className="section-head section-top" style={{ marginBottom: 6, paddingTop: 16 }}>
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
              placeholder="Darwin"
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
            ) : profiles.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--text-45)", padding: "6px 0" }}>
                No aircraft profiles available — check the server is running.
              </div>
            ) : (
              <select value={effectiveProfileId} onChange={(e) => setAircraftProfileId(e.target.value)}>
                {profiles.map((ac) => (
                  <option key={ac.id} value={ac.id}>
                    {ac.name} ({ac.coverage}%)
                  </option>
                ))}
              </select>
            )}
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
            </div>
          </div>

          {error && <div style={{ color: "#e24c4b", fontSize: 13 }}>{error}</div>}

          <div style={{ paddingTop: 6 }}>
            <button className="btn" onClick={handleCreate} disabled={submitting}>
              {submitting ? "Creating…" : "Create session"}
            </button>
          </div>
        </div>

        <div>
          <div className="divider-row" style={{ marginBottom: 10, border: "none" }}>
            <label className="mono-label">Code for your friend</label>
          </div>
          <div className="code-box">
            <div className="code-value">{createdSession?.joinCode ?? "— — — —"}</div>
            <div className="code-caption">
              {createdSession
                ? "Share this code so they can join your cockpit"
                : "Create the session to generate a real code"}
            </div>
          </div>

          {createdSession && (
            <div style={{ marginBottom: 16 }}>
              <button className="btn" onClick={() => onSessionReady(createdSession, pilotName)}>
                Enter cockpit
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
