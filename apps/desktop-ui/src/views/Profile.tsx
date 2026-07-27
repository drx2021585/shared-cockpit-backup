import { currentVersion } from "../data";
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

  return (
    <div className="section" style={{ paddingTop: 32, paddingBottom: 64 }}>
      <div className="section-head section-top" style={{ marginBottom: 10 }}>
        <h2 className="h2-sm">My profile</h2>
      </div>
      <p className="lead-sm" style={{ maxWidth: 560 }}>
        This is how other pilots see you when they fly with you.
      </p>
      <div style={{ maxWidth: 420, display: "flex", flexDirection: "column", gap: 24 }}>
        <div className="field">
          <label>Pilot name</label>
          <input
            type="text"
            placeholder="How you'll appear in the cockpit"
            value={pilotName}
            onChange={(e) => onPilotNameChange(e.target.value)}
          />
        </div>
        <p style={{ fontSize: 12, color: "var(--text-35)" }}>
          This name is used right away when you create or join a session — no separate save
          step needed.
        </p>
        <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 20 }}>
          <div className="mono-label" style={{ marginBottom: 10 }}>
            App version
          </div>
          <div style={{ fontSize: 13, color: "var(--text-70)", marginBottom: 14 }}>
            We Connect v{currentVersion}
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
            <button className="link-action" onClick={onCheckForUpdates}>
              Check for updates
            </button>
            <button className="link-action" onClick={handleOpenAppFolder}>
              View local app files
            </button>
          </div>
          {folderError && (
            <div style={{ color: "#e24c4b", fontSize: 12, marginTop: 12 }}>{folderError}</div>
          )}
        </div>
        {onChangeFlightSimFolder && (
          <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 20 }}>
            <div className="mono-label" style={{ marginBottom: 10 }}>
              Flight Simulator
            </div>
            <div style={{ fontSize: 13, color: "var(--text-70)", marginBottom: 14 }}>
              Community folder:{" "}
              <span style={{ color: communityPath ? "var(--text-70)" : "var(--text-35)" }}>
                {communityPath ?? "not set"}
              </span>
            </div>
            <button className="link-action" onClick={onChangeFlightSimFolder}>
              {communityPath ? "Change folder / reinstall packages" : "Set up Community folder"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
