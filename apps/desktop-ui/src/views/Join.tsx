import { useState } from "react";
import { joinSession, ApiError, type Session } from "../lib/apiClient";
import { parseDirectInviteCode } from "../lib/directInviteCode";
import { type RelayConfig } from "../lib/relayConfig";

interface JoinProps {
  pilotName: string;
  onPilotNameChange: (name: string) => void;
  onSessionReady: (session: Session, pilotName: string) => void;
  onRelayConfigChange: (config: RelayConfig) => void;
}

export function Join({ pilotName, onPilotNameChange, onSessionReady, onRelayConfigChange }: JoinProps) {
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [seat, setSeat] = useState<"captain" | "first_officer" | "observer">("first_officer");
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
      const directInvite = parseDirectInviteCode(code.trim());
      const resolvedJoinCode = directInvite?.joinCode ?? code.trim().toUpperCase();
      if (directInvite) {
        onRelayConfigChange({
          mode: "self-hosted",
          customBaseUrl: `http://${directInvite.host}:${directInvite.port}`,
        });
      }
      const session = await joinSession(resolvedJoinCode, {
        pilotName: pilotName.trim(),
        seat,
        password: password || undefined,
      });
      onSessionReady(session, pilotName);
    } catch (err) {
      const directInvite = parseDirectInviteCode(code.trim());
      if (err instanceof ApiError) {
        const messages: Record<string, string> = {
          "session-not-found": directInvite
            ? "That direct code reached your friend's PC, but the session is no longer open there."
            : "No session found with that code. If your friend is hosting directly, you need their direct invite code, not the short session code.",
          "invalid-password": "That password isn't correct.",
          "session-full": "This session already has two pilots.",
          "client-update-required": "Your We Connect is older than your friend's. Update it (Settings → Check for updates) and join again.",
        };
        setError(messages[err.code] ?? `Could not join: ${err.code}`);
      } else if (directInvite) {
        setError(
          `Could not reach your friend's PC at ${directInvite.host}:${directInvite.port}. ` +
            "That address only works if you are both on the same network, and their firewall has to let We Connect accept connections."
        );
      } else {
        setError("Could not reach the server.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="section" style={{ paddingTop: 24, paddingBottom: 32 }}>
      <div className="section-head" style={{ marginBottom: 6, paddingTop: 16 }}>
        <h2 className="h2-modal">Join a party</h2>
      </div>
      <p className="lead-sm" style={{ maxWidth: 560, marginBottom: 22, fontSize: 13 }}>
        Enter the code your friend shared to join their cockpit. Direct invite codes are accepted too.
      </p>
      <form
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void handleJoin();
        }}
        style={{ maxWidth: 420, display: "flex", flexDirection: "column", gap: 16 }}
      >
        <input
          type="text"
          name="fake-username"
          autoComplete="username"
          tabIndex={-1}
          aria-hidden="true"
          className="autofill-decoy"
        />
        <input
          type="password"
          name="fake-password"
          autoComplete="current-password"
          tabIndex={-1}
          aria-hidden="true"
          className="autofill-decoy"
        />
        <div className="field">
          <label>Your pilot name</label>
          <input
            type="text"
            name="weconnect-pilot-name"
            placeholder="Friend"
            value={pilotName}
            onChange={(e) => onPilotNameChange(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label>Session code or direct invite code</label>
          <input
            type="text"
            name="weconnect-session-code"
            placeholder=""
            className="mono"
            style={{ fontSize: 20, letterSpacing: "0.1em" }}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-form-type="other"
          />
        </div>
        <div className="field">
          <label>Password (if required)</label>
          <input
            type="password"
            name="weconnect-session-password"
            placeholder="••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-form-type="other"
          />
        </div>
        <div className="field">
          <label>Your role</label>
          <div className="seat-toggle">
            <button
              className={`seat-option ${seat === "captain" ? "active" : ""}`}
              onClick={() => setSeat("captain")}
              type="button"
            >
              Captain
            </button>
            <button
              className={`seat-option ${seat === "first_officer" ? "active" : ""}`}
              onClick={() => setSeat("first_officer")}
              type="button"
            >
              First officer
            </button>
            <button
              className={`seat-option ${seat === "observer" ? "active" : ""}`}
              onClick={() => setSeat("observer")}
              type="button"
            >
              Observer
            </button>
          </div>
          <p style={{ color: "var(--text-45)", fontSize: 12, marginTop: 8 }}>
            Only the captain and the first officer can request or receive flight controls.
          </p>
        </div>
        {error && <div style={{ color: "#e24c4b", fontSize: 13 }}>{error}</div>}
        <div style={{ paddingTop: 6 }}>
          <button className="btn" type="submit" disabled={submitting}>
            {submitting ? "Joining…" : "Join session"}
          </button>
        </div>
      </form>
    </div>
  );
}
