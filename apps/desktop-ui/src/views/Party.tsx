import { useState } from "react";
import { useAircraftProfiles } from "../lib/useAircraftProfiles";
import { createSession, fetchServerHealth, ApiError, type Session } from "../lib/apiClient";
import {
  buildCustomRelayApiBaseUrl,
  DEFAULT_DIRECT_PORT,
  getRelayConfig,
  setRelayConfig,
  type RelayMode,
} from "../lib/relayConfig";

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
  const [relayMode, setRelayMode] = useState<RelayMode>(relayConfig.mode);
  const [relayHost, setRelayHost] = useState(relayConfig.customHost ?? "");
  const [directPort, setDirectPort] = useState<number>(relayConfig.directPort);
  const [relaySaved, setRelaySaved] = useState<string | null>(null);
  const customRelayUrl = relayMode === "custom"
    ? buildCustomRelayApiBaseUrl({
      customHost: relayHost,
      customUrl: null,
      directPort,
    })
    : null;
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
  const [observerConfirmOpen, setObserverConfirmOpen] = useState(false);
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

  function applyRelaySettings() {
    setRelayConfig({
      mode: relayMode,
      customHost: relayMode === "custom" ? relayHost.trim() || null : null,
      customUrl: null,
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
                type="button"
                className={`seat-option ${relayMode === "hosted" ? "active" : ""}`}
                onClick={() => setRelayMode("hosted")}
              >
                Hosted relay
              </button>
              <button
                type="button"
                className={`seat-option ${relayMode === "custom" ? "active" : ""}`}
                onClick={() => setRelayMode("custom")}
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
                    onChange={(e) => setDirectPort(Number(e.target.value) || DEFAULT_DIRECT_PORT)}
                  />
                </div>
                <div className="field">
                  <label>Public IPv4</label>
                  <input
                    type="text"
                    placeholder="YOUR-PUBLIC-IP"
                    value={relayHost}
                    onChange={(e) => setRelayHost(e.target.value)}
                  />
                </div>
                <div style={{ fontSize: 12, color: "var(--text-35)" }}>
                  Guests connect to: <span className="mono">{customRelayUrl ?? "http://YOUR-PUBLIC-IP:25071"}</span>
                </div>
              </>
            )}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <button className="link-action" type="button" onClick={applyRelaySettings}>
                Save connection settings
              </button>
              {relaySaved && <div style={{ color: "var(--green)", fontSize: 12 }}>{relaySaved}</div>}
            </div>
          </div>
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
                <div>1. The local direct host is running on TCP {directPort}.</div>
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
