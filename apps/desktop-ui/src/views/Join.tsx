import { useState } from "react";
import { joinSession, ApiError, type Session } from "../lib/apiClient";
import { getRelayConfig, setRelayConfig, type RelayMode } from "../lib/relayConfig";

interface JoinProps {
  pilotName: string;
  onPilotNameChange: (name: string) => void;
  onSessionReady: (session: Session, pilotName: string) => void;
}

export function Join({ pilotName, onPilotNameChange, onSessionReady }: JoinProps) {
  const relayConfig = getRelayConfig();
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [seat, setSeat] = useState<"captain" | "first_officer" | "observer">("first_officer");
  const [observerConfirmOpen, setObserverConfirmOpen] = useState(false);
  const [relayMode, setRelayMode] = useState<RelayMode>(relayConfig.mode);
  const [relayUrl, setRelayUrl] = useState(relayConfig.customUrl ?? "");
  const [directPort, setDirectPort] = useState<number>(relayConfig.directPort);
  const [relaySaved, setRelaySaved] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function applyRelaySettings() {
    let nextUrl = relayUrl.trim();
    if (relayMode === "custom" && nextUrl) {
      try {
        const parsed = new URL(nextUrl);
        parsed.port = String(directPort);
        nextUrl = parsed.toString().replace(/\/+$/, "");
        setRelayUrl(nextUrl);
      } catch {
        // Dejar el texto tal cual si todavía no parsea.
      }
    }
    setRelayConfig({
      mode: relayMode,
      customUrl: relayMode === "custom" ? (nextUrl || null) : null,
      directPort,
    });
    setRelaySaved(
      relayMode === "custom"
        ? "Direct connection settings saved for this PC."
        : "Hosted relay selected for this PC."
    );
  }

  function requestObserverSeat() {
    setObserverConfirmOpen(true);
  }

  function acceptObserverSeat() {
    setSeat("observer");
    setObserverConfirmOpen(false);
  }

  async function handleJoin() {
    if (!pilotName.trim()) {
      setError("Enter your pilot name first.");
      return;
    }
    if (!code.trim()) {
      setError("Enter the session code.");
      return;
    }
    if (relayMode === "custom" && !relayUrl.trim()) {
      setError("Enter the relay URL for My own relay.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      let nextUrl = relayUrl.trim();
      if (relayMode === "custom" && nextUrl) {
        try {
          const parsed = new URL(nextUrl);
          parsed.port = String(directPort);
          nextUrl = parsed.toString().replace(/\/+$/, "");
          setRelayUrl(nextUrl);
        } catch {
          // Si la URL escrita no parsea todavía, se deja tal cual y el join fallará con error claro.
        }
      }
      setRelayConfig({
        mode: relayMode,
        customUrl: relayMode === "custom" ? (nextUrl || null) : null,
        directPort,
      });
      const session = await joinSession(code.trim().toUpperCase(), {
        pilotName: pilotName.trim(),
        seat,
        password: password || undefined,
      });
      onSessionReady(session, pilotName);
    } catch (err) {
      if (err instanceof ApiError) {
        const messages: Record<string, string> = {
          "session-not-found": "No session found with that code. Check that your friend created the session and that you typed the code exactly.",
          "invalid-password": "That password isn't correct.",
          "session-full": "This session already has two pilots.",
          "client-update-required": "Your We Connect is older than your friend's. Update it (Settings → Check for updates) and join again.",
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
      <div className="section-head" style={{ marginBottom: 6, paddingTop: 16 }}>
        <h2 className="h2-modal">Join a party</h2>
      </div>
      <p className="lead-sm" style={{ maxWidth: 560, marginBottom: 22, fontSize: 13 }}>
        Enter the code your friend shared to join their cockpit.
      </p>
      <form
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void handleJoin();
        }}
        style={{ maxWidth: 420, display: "flex", flexDirection: "column", gap: 16 }}
      >
        <div
          style={{
            border: "1px solid var(--hairline)",
            background: "rgba(255,255,255,0.03)",
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div className="mono-label">Connection</div>
          <div className="seat-toggle">
            <button
              className={`seat-option ${relayMode === "hosted" ? "active" : ""}`}
              onClick={() => setRelayMode("hosted")}
              type="button"
            >
              Hosted relay
            </button>
            <button
              className={`seat-option ${relayMode === "custom" ? "active" : ""}`}
              onClick={() => setRelayMode("custom")}
              type="button"
            >
              My own relay
            </button>
          </div>
          {relayMode === "custom" && (
            <>
              <div className="field">
                <label>Direct host port</label>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={directPort}
                  onChange={(e) => setDirectPort(Number(e.target.value) || 25071)}
                />
              </div>
              <div className="field">
                <label>Relay URL</label>
                <input
                  type="text"
                  placeholder="http://HOST-PUBLIC-IP:25071"
                  value={relayUrl}
                  onChange={(e) => setRelayUrl(e.target.value)}
                />
              </div>
              <p style={{ color: "var(--text-35)", fontSize: 12, margin: 0 }}>
                Use the same URL and the same TCP port your host configured.
              </p>
            </>
          )}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <button className="link-action" onClick={applyRelaySettings} type="button">
              Save connection settings
            </button>
            {relaySaved && <div style={{ color: "var(--green)", fontSize: 12 }}>{relaySaved}</div>}
          </div>
        </div>
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
          <label>Session code</label>
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
              onClick={requestObserverSeat}
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
      {observerConfirmOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            zIndex: 1000,
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 520,
              background: "var(--bg-elevated, #101010)",
              border: "1px solid var(--hairline)",
              padding: 24,
              display: "flex",
              flexDirection: "column",
              gap: 18,
            }}
          >
            <div className="mono-label">Observer seat confirmation</div>
            <div style={{ color: "var(--text-70)", lineHeight: 1.5 }}>
              Estas conciente que al esatr en esta silla,no podras tocar,mover y influir en deciciones de los capitanes / primer oficial?
            </div>
            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
              <button className="link-action" type="button" onClick={() => setObserverConfirmOpen(false)}>
                Atras
              </button>
              <button className="btn" type="button" onClick={acceptObserverSeat}>
                Aceptar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
