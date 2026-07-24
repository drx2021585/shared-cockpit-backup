import { currentVersion } from "../data";

interface ProfileProps {
  pilotName: string;
  onPilotNameChange: (name: string) => void;
  onCheckForUpdates: () => void;
}

export function Profile({ pilotName, onPilotNameChange, onCheckForUpdates }: ProfileProps) {
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
            WeConnect v{currentVersion}
          </div>
          <button className="link-action" onClick={onCheckForUpdates}>
            Check for updates
          </button>
        </div>
      </div>
    </div>
  );
}
