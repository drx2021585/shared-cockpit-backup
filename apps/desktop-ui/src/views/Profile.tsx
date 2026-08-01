import { currentVersion, versionHistory } from "../data";
import { useEffect, useState } from "react";
import {
  getDefaultRelayApiBaseUrl,
  getRelayConfig,
  setRelayConfig,
  type RelayMode,
} from "../lib/relayConfig";

interface ProfileProps {
  pilotName: string;
  onPilotNameChange: (name: string) => void;
  onCheckForUpdates: () => void;
  communityPath?: string | null;
  onChangeFlightSimFolder?: () => void;
}

export function Profile({
  pilotName,
  onPilotNameChange,
  onCheckForUpdates,
  communityPath,
  onChangeFlightSimFolder,
}: ProfileProps) {
  const [folderError, setFolderError] = useState<string | null>(null);
  const [expandedVersions, setExpandedVersions] = useState<Record<string, boolean>>({});
  const [relayMode, setRelayMode] = useState<RelayMode>(() => getRelayConfig().mode);
  const [customRelayUrl, setCustomRelayUrl] = useState<string>(() => getRelayConfig().customUrl ?? "");
  const [relaySaved, setRelaySaved] = useState<string | null>(null);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [relayTesting, setRelayTesting] = useState(false);
  const [directPort, setDirectPort] = useState<number>(25071);
  const [directRunning, setDirectRunning] = useState(false);
  const [directStatus, setDirectStatus] = useState<string | null>(null);
  const [publicIpv4, setPublicIpv4] = useState<string | null>(null);

  const autoRelayUrl = publicIpv4 ? `http://${publicIpv4}:${directPort}` : "";

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

  useEffect(() => {
    const relay = window.weconnectRelay;
    if (!relay) return;
    relay
      .getConfig()
      .then((config) => {
        setDirectPort(config.port ?? config.defaultPort);
        setDirectRunning(config.running);
      })
      .catch(() => undefined);
    window.weconnectNetwork?.getPublicAddresses()
      .then((info) => {
        setPublicIpv4(info.ipv4);
      })
      .catch(() => undefined);
  }, []);

  function saveRelaySettings() {
    setRelayConfig({
      mode: relayMode,
      customUrl: relayMode === "custom" ? (autoRelayUrl || customRelayUrl) : null,
      directPort,
    });
    setRelayError(null);
    setRelaySaved(
      relayMode === "hosted"
        ? "We Connect hosted relay selected."
        : "Custom relay saved. New sessions and joins will use that URL."
    );
  }

  async function testRelayUrl() {
    const base =
      relayMode === "hosted"
        ? getDefaultRelayApiBaseUrl()
        : (autoRelayUrl || customRelayUrl).trim().replace(/\/+$/, "");
    if (!base) {
      setRelayError("Enter the relay URL first.");
      return;
    }
    setRelaySaved(null);
    setRelayError(null);
    setRelayTesting(true);
    try {
      const response = await fetch(`${base}/api/health`, {
        headers: { "X-WeConnect-Client-Version": currentVersion },
      });
      if (!response.ok) {
        setRelayError(`Relay responded with HTTP ${response.status}.`);
        return;
      }
      setRelaySaved(`Relay reachable at ${base}.`);
    } catch {
      setRelayError("Could not reach that relay URL.");
    } finally {
      setRelayTesting(false);
    }
  }

  async function handleStartDirectHost() {
    setDirectStatus(null);
    const result = await window.weconnectRelay?.startDirectHost(Number(directPort));
    if (!result?.ok) {
      setDirectRunning(false);
      setDirectStatus(result?.error ?? "Could not start the direct host.");
      return;
    }
    setDirectRunning(true);
    setDirectPort(result.port ?? directPort);
    setDirectStatus(`Direct host listening on TCP ${result.port}. Forward that same port to this PC.`);
  }

  async function handleStopDirectHost() {
    setDirectStatus(null);
    await window.weconnectRelay?.stopDirectHost();
    setDirectRunning(false);
    setDirectStatus("Direct host stopped.");
  }

  function formatHistoryDate(date: string) {
    return new Date(`${date}T00:00:00`).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
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
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="seat-toggle" style={{ maxWidth: 420 }}>
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
            <p style={{ fontSize: 12, color: "var(--text-35)", margin: 0 }}>
              Hosted relay works everywhere. My own relay is the port-forwarding mode: the host PC
              runs the session server locally, opens a TCP port on the router, and the guest points
              We Connect at that public URL.
            </p>
            {relayMode === "custom" && (
              <>
                <div className="field">
                  <label>Relay URL</label>
                  <input
                    type="text"
                    placeholder="http://YOUR-PUBLIC-IP:25071"
                    value={autoRelayUrl || customRelayUrl}
                    onChange={(e) => setCustomRelayUrl(e.target.value)}
                    readOnly={!!autoRelayUrl}
                  />
                </div>
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
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <button className="link-action" onClick={handleStartDirectHost}>
                    {directRunning ? "Restart local direct host" : "Start local direct host"}
                  </button>
                  <span style={{ color: "var(--text-35)" }}>|</span>
                  {directRunning && (
                    <>
                      <button className="link-action" onClick={handleStopDirectHost}>
                        Stop local direct host
                      </button>
                      <span style={{ color: "var(--text-35)" }}>|</span>
                    </>
                  )}
                  <button className="link-action" onClick={testRelayUrl} disabled={relayTesting}>
                    {relayTesting ? "Testing…" : "Test relay"}
                  </button>
                  <span style={{ color: "var(--text-35)" }}>|</span>
                  <button className="link-action" onClick={saveRelaySettings}>
                    Save relay settings
                  </button>
                </div>
                <div style={{ fontSize: 12, color: "var(--text-35)" }}>
                  {autoRelayUrl
                    ? "Relay URL is generated automatically from your public IPv4 and the direct-host port."
                    : "Public IPv4 could not be detected, so the relay URL stays manual."}
                </div>
              </>
            )}
            {relayMode === "hosted" && (
              <div style={{ fontSize: 12, color: "var(--text-35)" }}>
                Default relay URL: {getDefaultRelayApiBaseUrl()}
              </div>
            )}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {relayMode === "hosted" && (
                <>
                  <button className="link-action" onClick={testRelayUrl} disabled={relayTesting}>
                    {relayTesting ? "Testing…" : "Test relay"}
                  </button>
                  <button className="link-action" onClick={saveRelaySettings}>
                    Save relay settings
                  </button>
                </>
              )}
            </div>
            {directStatus && <div style={{ color: "var(--text-70)", fontSize: 12 }}>{directStatus}</div>}
            {relaySaved && <div style={{ color: "var(--green)", fontSize: 12 }}>{relaySaved}</div>}
            {relayError && <div style={{ color: "#e24c4b", fontSize: 12 }}>{relayError}</div>}
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
