import { useState } from "react";
import { requirements } from "../data";
import { InstallerWizard } from "../components/InstallerWizard";

export function Download() {
  const [showInstaller, setShowInstaller] = useState(false);

  return (
    <div className="section" style={{ paddingTop: 32, paddingBottom: 64 }}>
      <div className="section-head" style={{ marginBottom: 10 }}>
        <h2 className="h2-sm">Download the app</h2>
      </div>
      <p className="lead-sm" style={{ maxWidth: 560 }}>
        We Connect isn't packaged as an installable app yet — you're using the web build
        (<code style={{ fontFamily: "var(--font-mono)" }}>apps/desktop-ui</code>) directly. See{" "}
        <code style={{ fontFamily: "var(--font-mono)" }}>docs/decisiones/web-first.md</code> for
        the plan to wrap it with Tauri once the simulator bridge is real.
      </p>
      <div className="grid-2" style={{ maxWidth: 760 }}>
        <div>
          <div className="mono-label" style={{ marginBottom: 14 }}>
            Current state
          </div>
          <div style={{ fontSize: 16, color: "#fff", fontWeight: 400, marginBottom: 6 }}>
            Web build only
          </div>
          <div style={{ fontSize: 13, color: "var(--text-45)", fontWeight: 300, marginBottom: 24 }}>
            No Windows installer exists yet — apps/simulator-bridge (SimConnect) hasn't been
            built or tested against MSFS.
          </div>
          <button className="btn lg" onClick={() => setShowInstaller(true)}>
            Preview the installer
          </button>
          <div style={{ fontSize: 11.5, color: "var(--text-25)", marginTop: 10, maxWidth: 320 }}>
            This is a UX preview of the future installer flow — it doesn't install anything real.
          </div>
        </div>
        <div>
          <div className="mono-label" style={{ marginBottom: 14 }}>
            Requirements (once packaged)
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {requirements.map((req) => (
              <div key={req} style={{ fontSize: 13.5, color: "var(--text-70)", fontWeight: 300 }}>
                {req}
              </div>
            ))}
          </div>
        </div>
      </div>
      {showInstaller && (
        <div className="modal-overlay" onClick={() => setShowInstaller(false)}>
          <div onClick={(e) => e.stopPropagation()}>
            <InstallerWizard onClose={() => setShowInstaller(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
