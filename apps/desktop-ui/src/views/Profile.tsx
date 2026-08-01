import { currentVersion, versionHistory } from "../data";
import { useEffect, useState } from "react";
import { fetchServerHealth } from "../lib/apiClient";
import {
  getDefaultRelayApiBaseUrl,
  normalizeRelayBaseUrl,
  readDirectHostPort,
  writeDirectHostPort,
  DEFAULT_DIRECT_HOST_PORT,
  type RelayConfig,
} from "../lib/relayConfig";
import { usePublicIp } from "../lib/useNetworkInfo";

interface ProfileProps {
  pilotName: string;
  onPilotNameChange: (name: string) => void;
  onCheckForUpdates: () => void;
  communityPath?: string | null;
  onChangeFlightSimFolder?: () => void;
  relayConfig: RelayConfig;
  onRelayConfigChange: (config: RelayConfig) => void;
}

export function Profile({
  pilotName,
  onPilotNameChange,
  onCheckForUpdates,
  communityPath,
  onChangeFlightSimFolder,
  relayConfig,
  onRelayConfigChange,
}: ProfileProps) {
  const localDirectRelayBaseUrl = `http://127.0.0.1:${readDirectHostPort()}`;
  const [folderError, setFolderError] = useState<string | null>(null);
  const [expandedVersions, setExpandedVersions] = useState<Record<string, boolean>>({});
  const [relayDraft, setRelayDraft] = useState(relayConfig.customBaseUrl);
  const [relayMessage, setRelayMessage] = useState<string | null>(null);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [testingRelay, setTestingRelay] = useState(false);
  const [portDraft, setPortDraft] = useState(String(readDirectHostPort()));
  const { ipv4 } = usePublicIp();
  // El puerto sale del relay activo, no de una constante: es configurable y
  // ademas el direct host cae al siguiente si el elegido esta ocupado.
  const activeRelayPort = (() => {
    try {
      return new URL(normalizeRelayBaseUrl(relayConfig.customBaseUrl)).port || String(readDirectHostPort());
    } catch {
      return String(readDirectHostPort());
    }
  })();
  const suggestedRelayUrl =
    ipv4 !== "Unavailable" && ipv4 !== "Detecting…" ? `http://${ipv4}:${activeRelayPort}` : null;
  const activeRelayUrl =
    relayConfig.mode === "managed"
      ? getDefaultRelayApiBaseUrl()
      : normalizeRelayBaseUrl(relayConfig.customBaseUrl) || localDirectRelayBaseUrl;

  useEffect(() => {
    setRelayDraft(relayConfig.customBaseUrl);
  }, [relayConfig.customBaseUrl]);

  function toggleVersion(version: string) {
    setExpandedVersions((current) => ({
      ...current,
      [version]: !current[version],
    }));
  }

  async function handleOpenAppFolder() {
    setFolderError(null);
    if (!window.weconnectDesktop) {
      setFolderError("Available only in the We Connect desktop app.");
      return;
    }
    try {
      const error = await window.weconnectDesktop.openInstallFolder();
      if (error) setFolderError(error);
    } catch {
      setFolderError("Could not open the app folder.");
    }
  }

  function formatHistoryDate(date: string) {
    return new Date(`${date}T00:00:00`).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function handleSaveRelay(mode: RelayConfig["mode"], customBaseUrl?: string) {
    setRelayError(null);
    setRelayMessage(null);
    const nextBaseUrl =
      mode === "self-hosted" ? normalizeRelayBaseUrl(customBaseUrl ?? relayDraft) : "";
    if (mode === "self-hosted" && !nextBaseUrl) {
      setRelayError("Enter the IP or URL of the relay host, for example http://192.168.1.20:8787");
      return;
    }
    onRelayConfigChange({ mode, customBaseUrl: nextBaseUrl });
    setRelayDraft(nextBaseUrl);
    setRelayMessage(
      mode === "managed"
        ? "Using the We Connect hosted relay again."
        : `Self-hosted relay saved: ${nextBaseUrl}`
    );
  }

  function handleSavePort() {
    const port = Number(portDraft);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setRelayError("The port must be a number between 1024 and 65535.");
      setPortDraft(String(readDirectHostPort()));
      return;
    }
    writeDirectHostPort(port);
    setRelayError(null);
    setRelayMessage(`Direct host port set to ${port}. Your friend has to use the same one.`);
  }

  async function handleUseSuggestedRelay() {
    if (!suggestedRelayUrl) {
      setRelayError("Local IPv4 is still being detected on this PC.");
      setRelayMessage(null);
      return;
    }
    let nextBaseUrl = localDirectRelayBaseUrl;
    if (window.weconnectDirectRelay) {
      const started = await window.weconnectDirectRelay.ensureHost(readDirectHostPort());
      if (!started.ok) {
        setRelayError(started.error ?? "Could not start the direct host on this PC.");
        setRelayMessage(null);
        return;
      }
      nextBaseUrl = started.baseUrl ?? localDirectRelayBaseUrl;
    }
    setRelayDraft(nextBaseUrl);
    handleSaveRelay("self-hosted", nextBaseUrl);
  }

  async function handleTestRelay() {
    const normalized = normalizeRelayBaseUrl(relayConfig.mode === "self-hosted" ? relayConfig.customBaseUrl || relayDraft : relayDraft);
    if (!normalized) {
      setRelayError("Enter the IP or URL of the relay host first.");
      return;
    }
    setTestingRelay(true);
    setRelayError(null);
    setRelayMessage(null);
    try {
      const health = await fetchServerHealth(normalized);
      setRelayMessage(
        `Relay reachable. API v${health.apiVersion} · min app ${health.minClientVersion} · latest ${health.latestClientVersion}`
      );
    } catch {
      setRelayError("Could not reach that relay. Check the IP, port and firewall on both PCs.");
    } finally {
      setTestingRelay(false);
    }
  }

  return (
    <div className="section" style={{ paddingTop: 32, paddingBottom: 64 }}>
      <div className="section-head" style={{ marginBottom: 10 }}>
        <h2 className="h2-sm">My profile</h2>
      </div>
      <p className="lead-sm" style={{ maxWidth: 560 }}>
        This is how other pilots see you when they fly with you.
      </p>
      <div style={{ maxWidth: 620, display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 20 }}>
          <div className="mono-label" style={{ marginBottom: 14 }}>
            Pilot name
          </div>
          <div className="field">
            <input
              type="text"
              placeholder="How you'll appear in the cockpit"
              value={pilotName}
              onChange={(e) => onPilotNameChange(e.target.value)}
            />
          </div>
          <p style={{ fontSize: 12, color: "var(--text-35)", marginTop: 14 }}>
            This name is used right away when you create or join a session — no separate save
            step needed.
          </p>
        </div>
        <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 20 }}>
          <div className="mono-label" style={{ marginBottom: 10 }}>
            Session relay
          </div>
          <div className="relay-shell">
            <div className="relay-summary-card">
              <div className="relay-summary-top">
                <div>
                  <div className="relay-summary-label">Current route</div>
                  <div className="relay-summary-value">
                    {relayConfig.mode === "managed" ? "We Connect hosted relay" : "Self-hosted relay"}
                  </div>
                </div>
                <div className={`relay-mode-pill ${relayConfig.mode === "managed" ? "managed" : "self-hosted"}`}>
                  {relayConfig.mode === "managed" ? "Managed" : "Direct / LAN"}
                </div>
              </div>
              <div className="relay-summary-url">{activeRelayUrl || getDefaultRelayApiBaseUrl()}</div>
              <div className="relay-summary-meta">
                {relayConfig.mode === "managed"
                  ? "Best for internet sessions without extra setup."
                  : "This app will use the host below for session creation, join and live WebSocket traffic."}
              </div>
            </div>

            <div className="relay-grid">
              <div className={`relay-option-card ${relayConfig.mode === "managed" ? "active" : ""}`}>
                <div className="relay-option-head">
                  <div>
                    <div className="relay-option-title">We Connect hosted relay</div>
                    <div className="relay-option-subtitle">No LAN setup. Uses the public shared relay.</div>
                  </div>
                  {relayConfig.mode === "managed" && <div className="relay-option-badge">Active</div>}
                </div>
                <div className="relay-option-url">{getDefaultRelayApiBaseUrl()}</div>
                <div className="relay-option-actions">
                  <button className="btn" onClick={() => handleSaveRelay("managed")}>
                    Use hosted relay
                  </button>
                </div>
              </div>

              <div className={`relay-option-card ${relayConfig.mode === "self-hosted" ? "active" : ""}`}>
                <div className="relay-option-head">
                  <div>
                    <div className="relay-option-title">My own relay host</div>
                    <div className="relay-option-subtitle">For LAN or self-hosted sessions from one PC.</div>
                  </div>
                  {relayConfig.mode === "self-hosted" && <div className="relay-option-badge">Active</div>}
                </div>
                <div className="relay-suggested-box">
                  <div className="relay-suggested-label">Suggested on this PC</div>
                  <div className="relay-suggested-value">
                    {suggestedRelayUrl ?? "Detecting local IPv4..."}
                  </div>
                  <button className="link-action" onClick={handleUseSuggestedRelay}>
                    Use this PC as host
                  </button>
                </div>
                <div className="field">
                  <label>Direct host port</label>
                  <input
                    type="number"
                    min={1024}
                    max={65535}
                    placeholder={String(DEFAULT_DIRECT_HOST_PORT)}
                    value={portDraft}
                    onChange={(e) => setPortDraft(e.target.value)}
                    onBlur={handleSavePort}
                  />
                  <p style={{ fontSize: 12, color: "var(--text-35)", marginTop: 8 }}>
                    Both pilots must use the same port. Default is {DEFAULT_DIRECT_HOST_PORT}, the same one
                    YourControls uses, so a router rule you already have keeps working.
                  </p>
                </div>
                <div className="field">
                  <label>Custom relay host</label>
                  <input
                    type="text"
                    placeholder={`http://192.168.1.20:${DEFAULT_DIRECT_HOST_PORT}`}
                    value={relayDraft}
                    onChange={(e) => setRelayDraft(e.target.value)}
                  />
                </div>
                <div className="relay-option-actions">
                  <button className="btn" onClick={() => handleSaveRelay("self-hosted")}>
                    Save self-hosted relay
                  </button>
                  <button className="link-action" onClick={handleTestRelay} disabled={testingRelay}>
                    {testingRelay ? "Testing relay..." : "Test relay"}
                  </button>
                </div>
              </div>
            </div>

            {relayMessage && <div className="relay-feedback ok">{relayMessage}</div>}
            {relayError && <div className="relay-feedback error">{relayError}</div>}
          </div>
        </div>
        <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 20 }}>
          <div className="mono-label" style={{ marginBottom: 10 }}>
            App version
          </div>
          <div style={{ fontSize: 13, color: "var(--text-70)", marginBottom: 14 }}>
            We Connect v{currentVersion}
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12, marginBottom: 18 }}>
            <button className="link-action" onClick={onCheckForUpdates}>
              Check for updates
            </button>
          </div>
          <div className="mono-label" style={{ marginBottom: 12 }}>
            Version history
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {versionHistory.map((entry) => {
              const isExpanded = expandedVersions[entry.version] ?? false;
              return (
                <div key={entry.version} className="profile-history-card">
                  <button
                    type="button"
                    className="profile-history-toggle"
                    onClick={() => toggleVersion(entry.version)}
                    aria-expanded={isExpanded}
                  >
                    <div className="profile-history-head">
                      <div>
                        <div className="profile-history-version">v{entry.version}</div>
                        <div className="profile-history-title">
                          {entry.title}
                          {entry.date ? ` · ${formatHistoryDate(entry.date)}` : ""}
                        </div>
                      </div>
                      <span className={`profile-history-caret${isExpanded ? " expanded" : ""}`}>^</span>
                    </div>
                  </button>
                  {isExpanded && (
                    <div className="profile-history-list">
                      {entry.commits.map((commit) => (
                        <div key={commit} className="profile-history-item">
                          <span className="profile-history-bullet">&gt;</span>
                          <span>{commit}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 20 }}>
          <div className="mono-label" style={{ marginBottom: 10 }}>
            Folders
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
            <button className="link-action" onClick={handleOpenAppFolder}>
              View local app files
            </button>
            {onChangeFlightSimFolder && (
              <>
                <div style={{ fontSize: 13, color: "var(--text-70)", marginTop: 6 }}>
                  Flight Simulator 2020 Community folder:{" "}
                  <span style={{ color: communityPath ? "var(--text-70)" : "var(--text-35)" }}>
                    {communityPath ?? "not set"}
                  </span>
                </div>
                <button className="link-action" onClick={onChangeFlightSimFolder}>
                  {communityPath ? "Change folder / reinstall packages" : "Set up Community folder"}
                </button>
              </>
            )}
          </div>
          {folderError && (
            <div style={{ color: "#e24c4b", fontSize: 12, marginTop: 12 }}>{folderError}</div>
          )}
        </div>
      </div>
    </div>
  );
}
