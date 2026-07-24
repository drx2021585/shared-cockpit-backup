import { useEffect, useRef, useState } from "react";
import {
  currentVersion,
  latestVersion,
  updateChangelog,
  updateDownloadSizeMb,
  updateEstSeconds,
} from "../data";

type UpdateState = "available" | "downloading" | "installing" | "error" | "complete";

interface UpdateModalProps {
  open: boolean;
  onClose: () => void;
}

const EYEBROW_LABEL: Record<UpdateState, string> = {
  available: "Software update",
  downloading: "Downloading update",
  installing: "Installing",
  error: "Update failed",
  complete: "Update complete",
};

export function UpdateModal({ open, onClose }: UpdateModalProps) {
  const [state, setState] = useState<UpdateState>("available");
  const [progress, setProgress] = useState(0);
  const [erroredAt, setErroredAt] = useState(0);
  const downloadTimerRef = useRef<number | null>(null);
  const advanceTimerRef = useRef<number | null>(null);

  // Every time the modal is opened, start fresh at "available" — there is no
  // real installer state to persist across sessions in this web-first build.
  useEffect(() => {
    if (open) {
      setState("available");
      setProgress(0);
    }
  }, [open]);

  function clearTimers() {
    if (downloadTimerRef.current !== null) {
      window.clearInterval(downloadTimerRef.current);
      downloadTimerRef.current = null;
    }
    if (advanceTimerRef.current !== null) {
      window.clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
  }

  useEffect(() => clearTimers, []);

  function startDownload() {
    clearTimers();
    setProgress(0);
    setState("downloading");
    downloadTimerRef.current = window.setInterval(() => {
      setProgress((prev) => {
        const next = Math.min(100, prev + 1.5 + Math.random() * 1.5);
        if (next >= 100) {
          if (downloadTimerRef.current !== null) {
            window.clearInterval(downloadTimerRef.current);
            downloadTimerRef.current = null;
          }
          advanceTimerRef.current = window.setTimeout(() => {
            setState("installing");
            advanceTimerRef.current = window.setTimeout(() => setState("complete"), 1400);
          }, 300);
        }
        return next;
      });
    }, 120);
  }

  function handleCancel() {
    clearTimers();
    setErroredAt(Math.round(progress));
    setState("error");
  }

  function handleTryAgain() {
    startDownload();
  }

  function handleRestartNow() {
    clearTimers();
    setState("available");
    onClose();
  }

  function handleRestartLater() {
    clearTimers();
    onClose();
  }

  if (!open) return null;

  const progressRounded = Math.round(progress);
  const downloadedMb = ((progressRounded / 100) * updateDownloadSizeMb).toFixed(1);

  return (
    <div className="modal-overlay">
      <div className="update-card">
        <button className="modal-close" onClick={onClose} aria-label="Close update dialog">
          ✕
        </button>

        <div className="update-header-row">
          <div
            className={`update-eyebrow${state === "error" ? " error" : ""}${
              state === "complete" ? " complete" : ""
            }`}
          >
            {EYEBROW_LABEL[state]}
          </div>
          <div className="update-optional-tag">Optional</div>
        </div>

        {state === "available" && (
          <>
            <div className="update-body-row">
              <div className="update-icon-box">↓</div>
              <div>
                <h3 className="update-title">A new version is ready</h3>
                <p className="update-desc">
                  WeConnect keeps both cockpits on the same build. Update to stay in sync with
                  your co-pilot.
                </p>
              </div>
            </div>
            <VersionTrack />
            <div className="update-changelog-label">What's new</div>
            <div className="update-changelog-list">
              {updateChangelog.map((line) => (
                <div className="update-changelog-item" key={line}>
                  <span className="update-changelog-arrow">→</span>
                  <span>{line}</span>
                </div>
              ))}
            </div>
            <div className="update-meta-row">
              <div>
                <div className="update-meta-label">Download size</div>
                <div className="update-meta-value">{updateDownloadSizeMb.toFixed(1)} MB</div>
              </div>
              <div>
                <div className="update-meta-label">Est. time</div>
                <div className="update-meta-value">~{updateEstSeconds} sec</div>
              </div>
            </div>
            <div className="update-actions">
              <button className="btn" onClick={startDownload}>
                Update now
              </button>
              <button className="update-btn-secondary" onClick={onClose}>
                Remind me later
              </button>
            </div>
          </>
        )}

        {state === "downloading" && (
          <>
            <div className="update-body-row">
              <div className="update-icon-box">↓</div>
              <div>
                <h3 className="update-title">Downloading update</h3>
                <p className="update-desc">
                  Fetching v{latestVersion}. You can keep this window open — it'll install
                  automatically.
                </p>
              </div>
            </div>
            <VersionTrack />
            <div className="update-progress-label-row">
              <span className="update-progress-task">Downloading v{latestVersion}</span>
              <span className="update-progress-pct">{progressRounded}%</span>
            </div>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${progressRounded}%` }} />
            </div>
            <div className="update-progress-meta-row">
              <span>
                {downloadedMb} MB / {updateDownloadSizeMb.toFixed(1)} MB
              </span>
              <span>4.2 MB/s</span>
            </div>
            <div className="update-actions">
              <button className="btn" style={{ background: "var(--text-25)" }} onClick={handleCancel}>
                Cancel
              </button>
            </div>
          </>
        )}

        {state === "installing" && (
          <>
            <div className="update-body-row">
              <div className="update-icon-box">⚙</div>
              <div>
                <h3 className="update-title">Installing update</h3>
                <p className="update-desc">Almost there. This only takes a moment and can't be interrupted.</p>
              </div>
            </div>
            <VersionTrack />
            <div className="update-installing-label">Applying update — do not close the app</div>
            <div className="bar-track" style={{ marginBottom: 22 }}>
              <div className="bar-fill" style={{ width: "100%" }} />
            </div>
            <div className="update-actions">
              <button className="btn" disabled style={{ opacity: 0.5, cursor: "not-allowed" }}>
                Installing…
              </button>
            </div>
          </>
        )}

        {state === "error" && (
          <>
            <div className="update-body-row">
              <div className="update-icon-box error">⚠</div>
              <div>
                <h3 className="update-title">Couldn't finish the update</h3>
                <p className="update-desc">Something interrupted the download. Nothing changed on your machine.</p>
              </div>
            </div>
            <VersionTrack />
            <div className="update-error-box">
              <div className="update-error-title">Error · Net_interrupted</div>
              <p className="update-error-text">
                The download was interrupted at {erroredAt}%. Check your connection and try again
                — your current version is unaffected.
              </p>
            </div>
            <div className="update-actions">
              <button className="btn" onClick={handleTryAgain}>
                Try again
              </button>
              <button className="update-btn-secondary" onClick={onClose}>
                Later
              </button>
            </div>
          </>
        )}

        {state === "complete" && (
          <>
            <div className="update-body-row">
              <div className="update-icon-box complete">✓</div>
              <div>
                <h3 className="update-title">You're up to date</h3>
                <p className="update-desc">Restart WeConnect to start flying on the newest build.</p>
              </div>
            </div>
            <VersionTrack />
            <div className="update-success-box">
              <div className="update-success-dot" />
              <p className="update-success-text">
                WeConnect <strong>v{latestVersion}</strong> is installed. Restart to finish.
              </p>
            </div>
            <div className="update-actions">
              <button className="btn" style={{ background: "var(--green)" }} onClick={handleRestartNow}>
                Restart now
              </button>
              <button className="update-btn-secondary" onClick={handleRestartLater}>
                Restart later
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function VersionTrack() {
  return (
    <div className="update-version-track">
      <span>v{currentVersion}</span>
      <div className="update-version-line">
        <span className="update-version-dot" />
      </div>
      <span className="update-version-target">v{latestVersion}</span>
    </div>
  );
}
