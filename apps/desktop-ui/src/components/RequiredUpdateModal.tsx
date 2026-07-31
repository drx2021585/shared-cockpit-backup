import { currentVersion } from "../data";

interface RequiredUpdateModalProps {
  open: boolean;
  minVersion: string;
  latestVersion: string;
  onOpenUpdater: () => void;
}

export function RequiredUpdateModal({
  open,
  minVersion,
  latestVersion,
  onOpenUpdater,
}: RequiredUpdateModalProps) {
  if (!open) return null;

  const desktop = (window as unknown as {
    weconnectDesktop?: { restartApp: () => Promise<void> };
  }).weconnectDesktop;

  return (
    <div className="modal-overlay">
      <div className="update-card" role="alertdialog" aria-modal="true" aria-labelledby="required-update-title">
        <div className="update-header-row">
          <div className="update-eyebrow error">Update required</div>
        </div>

        <div className="update-body-row">
          <div className="update-icon-box error">↑</div>
          <div>
            <h3 id="required-update-title" className="update-title">
              This version can no longer talk to the live server
            </h3>
            <p className="update-desc">
              {`We Connect v${currentVersion} is below the minimum supported version v${minVersion}. `}
              {`The live server now expects at least v${minVersion}${latestVersion !== minVersion ? `, and the latest published build is v${latestVersion}` : ""}.`}
            </p>
          </div>
        </div>

        <div className="update-error-box">
          <div className="update-error-title">Why this is blocked</div>
          <p className="update-error-text">
            Flight sessions, control authority and reconnect logic must stay on the same client/server contract.
            Update first, then restart We Connect.
          </p>
        </div>

        <div className="update-actions">
          <button className="btn" onClick={onOpenUpdater}>
            Check for updates
          </button>
          {desktop && (
            <button className="update-btn-secondary" onClick={() => void desktop.restartApp()}>
              Restart We Connect
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
