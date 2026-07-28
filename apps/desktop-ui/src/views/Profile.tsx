import { currentVersion, versionHistory } from "../data";
import { useState } from "react";

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

  return (
    <div className="section" style={{ paddingTop: 32, paddingBottom: 64 }}>
      <div className="section-head section-top" style={{ marginBottom: 10 }}>
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
