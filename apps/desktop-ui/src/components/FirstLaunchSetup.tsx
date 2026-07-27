import { useEffect, useRef, useState } from "react";

interface FirstLaunchSetupProps {
  /** El usuario cerró el asistente manualmente (✕ o Cancel) sin completar el
   * setup -- vuelve a aparecer en el próximo inicio, a propósito (ver spec:
   * "el usuario no puede utilizar la app hasta completar este proceso o
   * cerrarlo manualmente"; cerrar no cuenta como completar). */
  onClose: () => void;
  /** Terminó de verdad (packages copiados + config guardada) -- no debe
   * volver a aparecer. */
  onCompleted: (communityPath: string) => void;
}

type Phase = "folder" | "installing" | "done" | "error";

const TOTAL_BLOCKS = 20;
const BLOCK_MS = 120;

const TASKS: Array<[number, string]> = [
  [20, "Downloading logic..."],
  [40, "Downloading aircraft..."],
  [60, "Downloading documents..."],
  [80, "Optimizing database..."],
  [100, "Finalizing..."],
];

export function FirstLaunchSetup({ onClose, onCompleted }: FirstLaunchSetupProps) {
  const [phase, setPhase] = useState<Phase>("folder");
  const [folderPath, setFolderPath] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [installError, setInstallError] = useState<string | null>(null);

  const animTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (animTimerRef.current !== null) clearInterval(animTimerRef.current);
    };
  }, []);

  const setup = window.weconnectSetup;

  async function handleBrowse() {
    if (!setup) return;
    const picked = await setup.chooseFolder();
    if (picked) {
      setFolderPath(picked);
      setFolderError(null);
    }
  }

  function runInstall() {
    setPhase("installing");
    setInstallError(null);
    setProgress(0);

    // Barra visual: avanza en bloques del 5%, independiente de cuánto tarde
    // la copia real (que para nuestro paquete hoy es casi instantánea) --
    // el objetivo es que la instalación SE VEA fluida, no que refleje bytes
    // reales transferidos (ver spec: las tareas son "principalmente
    // estéticas"). La copia real corre en paralelo, de verdad, en segundo
    // plano (ver installPromise más abajo).
    let blocks = 0;
    animTimerRef.current = setInterval(() => {
      blocks += 1;
      setProgress(Math.min(100, blocks * (100 / TOTAL_BLOCKS)));
      if (blocks >= TOTAL_BLOCKS && animTimerRef.current !== null) {
        clearInterval(animTimerRef.current);
        animTimerRef.current = null;
      }
    }, BLOCK_MS);

    const minAnimationMs = TOTAL_BLOCKS * BLOCK_MS;
    const startedAt = Date.now();

    const installPromise = setup
      ? setup.installPackages(folderPath)
      : Promise.resolve({ ok: false, error: "Available only in the We Connect desktop app." });

    installPromise.then((result) => {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, minAnimationMs - elapsed);
      setTimeout(() => {
        if (animTimerRef.current !== null) {
          clearInterval(animTimerRef.current);
          animTimerRef.current = null;
        }
        setProgress(100);
        if (!result.ok) {
          setInstallError(result.error ?? "Unknown error while copying files.");
          setPhase("error");
          return;
        }
        setup?.markCompleted(folderPath);
        setPhase("done");
      }, remaining);
    });
  }

  async function handleAccept() {
    if (!setup) {
      setFolderError("Available only in the We Connect desktop app.");
      return;
    }
    if (!folderPath) {
      setFolderError("Choose your Community folder first.");
      return;
    }
    setValidating(true);
    setFolderError(null);
    try {
      const result = await setup.validateFolder(folderPath);
      if (!result.ok) {
        setFolderError(result.error ?? "That folder isn't valid.");
        return;
      }
      runInstall();
    } finally {
      setValidating(false);
    }
  }

  function handleRetry() {
    runInstall();
  }

  const filledBlocks = Math.round((progress / 100) * TOTAL_BLOCKS);

  return (
    <div className="modal-overlay">
      <div className="update-card" style={{ width: "min(480px, calc(100vw - 40px))" }}>
        {phase !== "installing" && (
          <button className="modal-close" onClick={onClose} aria-label="Close setup">
            ✕
          </button>
        )}

        {phase === "folder" && (
          <>
            <div className="update-header-row">
              <div className="update-eyebrow">First-time setup</div>
            </div>
            <h2 className="h2-modal" style={{ marginBottom: 10 }}>
              Welcome to We Connect
            </h2>
            <p style={{ color: "var(--text-55)", fontSize: 13, lineHeight: 1.6, marginBottom: 20 }}>
              To complete the initial setup, We Connect needs access to your Microsoft Flight
              Simulator 2020 Community folder.
              <br />
              <br />
              Required packages will be installed automatically. This process only takes a few
              seconds.
            </p>

            <div className="field" style={{ marginBottom: 8 }}>
              <label>Community folder</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="text"
                  readOnly
                  placeholder="…\Microsoft Flight Simulator\Packages\Community"
                  value={folderPath}
                  style={{ flex: 1 }}
                />
                <button className="btn" onClick={handleBrowse} style={{ padding: "0 16px" }}>
                  Browse…
                </button>
              </div>
            </div>
            {folderError && (
              <div style={{ color: "#f87171", fontSize: 12, marginBottom: 8 }}>{folderError}</div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22 }}>
              <button
                className="btn"
                onClick={onClose}
                style={{ background: "transparent", color: "var(--text-65)", border: "1px solid var(--hairline)" }}
              >
                Cancel
              </button>
              <button className="btn" onClick={handleAccept} disabled={validating || !folderPath}>
                {validating ? "Checking…" : "Accept"}
              </button>
            </div>
          </>
        )}

        {phase === "installing" && (
          <>
            <div className="update-header-row">
              <div className="update-eyebrow">Setup</div>
            </div>
            <h2 className="h2-modal" style={{ marginBottom: 20 }}>
              Installing We Connect package…
            </h2>

            <div style={{ display: "flex", gap: 3, marginBottom: 18 }}>
              {Array.from({ length: TOTAL_BLOCKS }).map((_, i) => (
                <div
                  key={i}
                  style={{
                    flex: 1,
                    height: 10,
                    background: i < filledBlocks ? "var(--accent)" : "rgba(199,248,254,0.08)",
                    boxShadow: i < filledBlocks ? "0 0 6px var(--accent)" : "none",
                    transition: "background 120ms ease, box-shadow 120ms ease",
                  }}
                />
              ))}
            </div>

            <div className="installer-log">
              {TASKS.filter(([threshold]) => progress >= threshold).map(([threshold, label]) => (
                <div
                  key={threshold}
                  className="installer-log-line"
                  style={{
                    color: "var(--green)",
                    animation: "fadeInTask 320ms ease",
                  }}
                >
                  <span>✔</span>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {phase === "done" && (
          <>
            <div className="update-header-row">
              <div className="update-eyebrow complete">Setup complete</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "50%",
                  background: "rgba(74,222,128,0.12)",
                  border: "1px solid rgba(74,222,128,0.4)",
                  color: "var(--green)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 16,
                }}
              >
                ✓
              </div>
              <h2 className="h2-modal" style={{ margin: 0 }}>
                Installation completed successfully.
              </h2>
            </div>
            <p style={{ color: "var(--text-55)", fontSize: 13, marginBottom: 22 }}>
              We Connect is ready to fly. You can change the Community folder later from Settings.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                className="btn"
                onClick={() => {
                  onCompleted(folderPath);
                  // Reinicio real (no solo cerrar el modal): la app vuelve a
                  // arrancar limpia con la config ya guardada. En el build
                  // web puro (sin Electron) no hay proceso que reiniciar --
                  // onCompleted ya cerró el modal, eso es lo único posible ahí.
                  window.weconnectDesktop?.restartApp();
                }}
              >
                Launch We Connect
              </button>
            </div>
          </>
        )}

        {phase === "error" && (
          <>
            <div className="update-header-row">
              <div className="update-eyebrow error">Setup failed</div>
            </div>
            <h2 className="h2-modal" style={{ marginBottom: 10 }}>
              Couldn't install the required packages
            </h2>
            <p style={{ color: "#f87171", fontSize: 13, lineHeight: 1.6, marginBottom: 22 }}>
              {installError}
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button
                className="btn"
                onClick={onClose}
                style={{ background: "transparent", color: "var(--text-65)", border: "1px solid var(--hairline)" }}
              >
                Cancel
              </button>
              <button className="btn" onClick={handleRetry}>
                Retry
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
