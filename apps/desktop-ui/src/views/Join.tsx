import { useState } from "react";
import { joinSession, ApiError, type Session } from "../lib/apiClient";

interface JoinProps {
  pilotName: string;
  onPilotNameChange: (name: string) => void;
  onSessionReady: (session: Session, pilotName: string) => void;
}

export function Join({ pilotName, onPilotNameChange, onSessionReady }: JoinProps) {
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleJoin() {
    if (!pilotName.trim()) {
      setError("Enter your pilot name first.");
      return;
    }
    if (!code.trim()) {
      setError("Enter the session code.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const session = await joinSession(code.trim().toUpperCase(), {
        pilotName: pilotName.trim(),
        seat: "first_officer",
        password: password || undefined,
      });
      onSessionReady(session, pilotName);
    } catch (err) {
      if (err instanceof ApiError) {
        const messages: Record<string, string> = {
          "session-not-found": "No session found with that code.",
          "invalid-password": "That password isn't correct.",
          "session-full": "This session already has two pilots.",
        };
        setError(messages[err.code] ?? `Could not join: ${err.code}`);
      } else {
        setError("Could not reach the server.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="section" style={{ paddingTop: 24, paddingBottom: 32 }}>
      <div className="section-head section-top" style={{ marginBottom: 6, paddingTop: 16 }}>
        <h2 className="h2-modal">Join a party</h2>
      </div>
      <p className="lead-sm" style={{ maxWidth: 560, marginBottom: 22, fontSize: 13 }}>
        Enter the code your friend shared to join their cockpit.
      </p>
      <div style={{ maxWidth: 420, display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="field">
          <label>Your pilot name</label>
          <input
            type="text"
            placeholder="Friend"
            value={pilotName}
            onChange={(e) => onPilotNameChange(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Session code</label>
          <input
            type="text"
            placeholder="X7K-92Q"
            className="mono"
            style={{ fontSize: 20, letterSpacing: "0.1em" }}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
        </div>
        <div className="field">
          <label>Password (if required)</label>
          <input type="password" placeholder="••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <div style={{ color: "#e24c4b", fontSize: 13 }}>{error}</div>}
        <div style={{ paddingTop: 6 }}>
          <button className="btn" onClick={handleJoin} disabled={submitting}>
            {submitting ? "Joining…" : "Join session"}
          </button>
        </div>
      </div>
    </div>
  );
}
