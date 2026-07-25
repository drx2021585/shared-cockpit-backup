import { useEffect, useState } from "react";
import { currentVersion } from "../data";

interface UpdateModalProps {
  open: boolean;
  onClose: () => void;
}

// --------------------------------------------------------------------------
// Puente hacia electron-updater (ver electron/main.cjs + electron/preload.cjs).
// Solo existe cuando la app corre empaquetada dentro de Electron.
// --------------------------------------------------------------------------
interface WeConnectUpdaterBridge {
  isElectron: true;
  getCurrentVersion: () => Promise<string>;
  check: () => Promise<void>;
  download: () => Promise<void>;
  quitAndInstall: () => Promise<void>;
  onEvent: (callback: (payload: UpdaterEvent) => void) => () => void;
}

type UpdaterEvent =
  | { status: "checking" }
  | { status: "available"; version: string; releaseNotes: string | null }
  | { status: "not-available"; version: string }
  | { status: "downloading"; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { status: "downloaded"; version: string }
  | { status: "error"; message: string };

function getElectronUpdater(): WeConnectUpdaterBridge | null {
  return (window as unknown as { weconnectUpdater?: WeConnectUpdaterBridge }).weconnectUpdater ?? null;
}

// --------------------------------------------------------------------------
// Fallback para el build web puro (sin Electron): no hay forma de
// autoactualizarse a sí mismo, así que solo se puede verificar contra el
// último release publicado en GitHub y enlazar a la descarga manual.
// --------------------------------------------------------------------------
interface GitHubAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  published_at: string;
  html_url: string;
  body: string | null;
  assets: GitHubAsset[];
}

const LATEST_RELEASE_URL = "https://api.github.com/repos/drx2021585/shared-cockpit-backup/releases/latest";

function normalizedVersion(version: string) {
  return version.trim().replace(/^v/i, "");
}

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function UpdateModal({ open, onClose }: UpdateModalProps) {
  const updater = getElectronUpdater();
  return updater ? (
    <ElectronUpdateModal updater={updater} open={open} onClose={onClose} />
  ) : (
    <WebUpdateModal open={open} onClose={onClose} />
  );
}

// --------------------------------------------------------------------------
// Modo real: dentro de la app empaquetada, vía electron-updater.
// --------------------------------------------------------------------------
function ElectronUpdateModal({
  updater,
  open,
  onClose,
}: {
  updater: WeConnectUpdaterBridge;
  open: boolean;
  onClose: () => void;
}) {
  const [event, setEvent] = useState<UpdaterEvent>({ status: "checking" });

  useEffect(() => {
    const unsubscribe = updater.onEvent(setEvent);
    return unsubscribe;
  }, [updater]);

  useEffect(() => {
    if (open) updater.check();
  }, [open, updater]);

  if (!open) return null;

  const status = event.status;

  return (
    <div className="modal-overlay">
      <div className="update-card" role="dialog" aria-modal="true" aria-labelledby="software-update-title">
        <button className="modal-close" onClick={onClose} aria-label="Close update dialog">
          ✕
        </button>

        <div className="update-header-row">
          <div className={`update-eyebrow${status === "error" ? " error" : ""}${status === "downloaded" ? " complete" : ""}`}>
            {status === "checking" && "Software update"}
            {status === "available" && "Software update"}
            {status === "not-available" && "Software update"}
            {status === "downloading" && "Downloading update"}
            {status === "downloaded" && "Update complete"}
            {status === "error" && "Update failed"}
          </div>
        </div>

        <div className="update-body-row">
          <div className={`update-icon-box${status === "error" ? " error" : ""}${status === "downloaded" ? " complete" : ""}`}>
            {status === "checking" && "…"}
            {status === "available" && "↓"}
            {status === "not-available" && "✓"}
            {status === "downloading" && "↓"}
            {status === "downloaded" && "✓"}
            {status === "error" && "⚠"}
          </div>
          <div>
            <h3 id="software-update-title" className="update-title">
              {status === "checking" && "Checking for updates"}
              {status === "available" && "A new version is ready"}
              {status === "not-available" && "You're up to date"}
              {status === "downloading" && "Downloading update…"}
              {status === "downloaded" && "Ready to install"}
              {status === "error" && "Couldn't check for updates"}
            </h3>
            <p className="update-desc">
              {status === "checking" && "Talking to GitHub Releases."}
              {status === "available" && `WeConnect v${event.version} is available — you're on v${currentVersion}.`}
              {status === "not-available" && `WeConnect v${currentVersion} is the latest published version.`}
              {status === "downloading" && "Keep this window open — it'll install automatically when done."}
              {status === "downloaded" && `WeConnect v${event.version} downloaded. Restart to finish installing.`}
              {status === "error" && event.message}
            </p>
          </div>
        </div>

        {status === "downloading" && (
          <>
            <div className="update-progress-label-row">
              <span className="update-progress-task">Downloading</span>
              <span className="update-progress-pct">{Math.round(event.percent)}%</span>
            </div>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${event.percent}%` }} />
            </div>
            <div className="update-progress-meta-row">
              <span>
                {formatBytes(event.transferred)} / {formatBytes(event.total)}
              </span>
              <span>{formatBytes(event.bytesPerSecond)}/s</span>
            </div>
          </>
        )}

        {status === "error" && (
          <div className="update-error-box">
            <div className="update-error-title">Update check failed</div>
            <p className="update-error-text">{event.message}</p>
          </div>
        )}

        {status === "downloaded" && (
          <div className="update-success-box">
            <span className="update-success-dot" />
            <p className="update-success-text">
              <strong>WeConnect v{event.version}</strong> is installed. Restart to start flying on the newest build.
            </p>
          </div>
        )}

        <div className="update-actions">
          {status === "available" && (
            <button className="btn" onClick={() => updater.download()}>
              Update now
            </button>
          )}
          {status === "downloaded" && (
            <button className="btn" onClick={() => updater.quitAndInstall()}>
              Restart now
            </button>
          )}
          {status === "error" && (
            <button className="btn" onClick={() => updater.check()}>
              Try again
            </button>
          )}
          <button className="update-btn-secondary" onClick={onClose}>
            {status === "downloading" ? "Continue in background" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Fallback web: sin Electron no hay auto-actualización posible, solo un
// chequeo real contra el último release público + enlace de descarga manual.
// --------------------------------------------------------------------------
type WebCheckState =
  | { status: "checking" }
  | { status: "ready"; release: GitHubRelease }
  | { status: "error"; message: string };

function WebUpdateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [check, setCheck] = useState<WebCheckState>({ status: "checking" });

  useEffect(() => {
    if (!open) return;

    const controller = new AbortController();
    setCheck({ status: "checking" });

    fetch(LATEST_RELEASE_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
        return (await response.json()) as GitHubRelease;
      })
      .then((release) => setCheck({ status: "ready", release }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setCheck({
          status: "error",
          message: error instanceof Error ? error.message : "The update check failed.",
        });
      });

    return () => controller.abort();
  }, [open]);

  if (!open) return null;

  const latestVersion = check.status === "ready" ? normalizedVersion(check.release.tag_name) : null;
  const upToDate = latestVersion === normalizedVersion(currentVersion);
  const installer =
    check.status === "ready"
      ? check.release.assets.find((asset) => asset.name.toLowerCase().endsWith(".exe"))
      : undefined;

  return (
    <div className="modal-overlay">
      <div className="update-card" role="dialog" aria-modal="true" aria-labelledby="software-update-title">
        <button className="modal-close" onClick={onClose} aria-label="Close update dialog">
          ✕
        </button>

        <div className="update-header-row">
          <div className="update-eyebrow">Software update</div>
        </div>

        <div className="update-body-row">
          <div className="update-icon-box">
            {check.status === "checking" ? "…" : check.status === "error" ? "⚠" : upToDate ? "✓" : "↓"}
          </div>
          <div>
            <h3 id="software-update-title" className="update-title">
              {check.status === "checking"
                ? "Checking for updates"
                : check.status === "error"
                  ? "Couldn't check for updates"
                  : upToDate
                    ? "You're up to date"
                    : "A new version is available"}
            </h3>
            <p className="update-desc">
              {check.status === "checking" && "Reading the latest public release from GitHub."}
              {check.status === "error" && "No version or download information could be verified."}
              {check.status === "ready" &&
                (upToDate
                  ? `WeConnect v${currentVersion} is the latest published version.`
                  : `DCS Interactive - We Connect div. has published WeConnect v${latestVersion}. The web build can't update itself — download the desktop app to get in-app auto-updates.`)}
            </p>
          </div>
        </div>

        <div className="update-meta-row">
          <div>
            <div className="update-meta-label">Installed version</div>
            <div className="update-meta-value">v{currentVersion}</div>
          </div>
          <div>
            <div className="update-meta-label">Latest release</div>
            <div className="update-meta-value">{check.status === "ready" ? `v${latestVersion}` : "—"}</div>
          </div>
        </div>

        {check.status === "ready" && (
          <div className="update-meta-row">
            <div>
              <div className="update-meta-label">Published</div>
              <div className="update-meta-value">{new Date(check.release.published_at).toLocaleDateString()}</div>
            </div>
            <div>
              <div className="update-meta-label">Installer size</div>
              <div className="update-meta-value">{installer ? formatBytes(installer.size) : "Not published"}</div>
            </div>
          </div>
        )}

        {check.status === "error" && (
          <div className="update-error-box">
            <div className="update-error-title">Update check failed</div>
            <p className="update-error-text">{check.message}</p>
          </div>
        )}

        <div className="update-actions">
          {check.status === "ready" && !upToDate && installer && (
            <a className="btn" href={installer.browser_download_url} target="_blank" rel="noreferrer">
              Download installer
            </a>
          )}
          {check.status === "ready" && (
            <a className="update-btn-secondary" href={check.release.html_url} target="_blank" rel="noreferrer">
              View release on GitHub
            </a>
          )}
          <button className="update-btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
