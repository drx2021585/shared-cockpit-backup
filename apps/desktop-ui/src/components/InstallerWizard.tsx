import { useEffect, useRef, useState } from "react";

type Step = "welcome" | "license" | "installing" | "done";

const STEP_ORDER: Step[] = ["welcome", "license", "installing", "done"];
const STEP_LABELS: Record<Step, string> = {
  welcome: "Welcome",
  license: "License",
  installing: "Install",
  done: "Finish",
};

const TASK_THRESHOLDS: [number, string][] = [
  [35, "Copying application files"],
  [70, "Installing SimConnect bridge"],
  [92, "Registering components"],
  [100, "Finishing up"],
];

const LOG_STEPS: [number, string][] = [
  [30, "Application files"],
  [65, "SimConnect bridge"],
  [90, "Aircraft profiles"],
];

interface InstallerWizardProps {
  onClose: () => void;
}

export function InstallerWizard({ onClose }: InstallerWizardProps) {
  const [step, setStep] = useState<Step>("welcome");
  const [agreed, setAgreed] = useState(false);
  const [shortcut, setShortcut] = useState(true);
  const [progress, setProgress] = useState(0);
  const intervalRef = useRef<number | null>(null);
  const doneTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (step === "installing" && intervalRef.current === null && progress < 100) {
      intervalRef.current = window.setInterval(() => {
        setProgress((prev) => {
          const next = Math.min(100, prev + (2 + Math.random() * 5));
          if (next >= 100) {
            if (intervalRef.current !== null) {
              window.clearInterval(intervalRef.current);
              intervalRef.current = null;
            }
            doneTimeoutRef.current = window.setTimeout(() => setStep("done"), 550);
          }
          return next;
        });
      }, 130);
    }
    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [step, progress]);

  useEffect(() => {
    return () => {
      if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
      if (doneTimeoutRef.current !== null) window.clearTimeout(doneTimeoutRef.current);
    };
  }, []);

  function startInstall() {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setProgress(0);
    setStep("installing");
  }

  function handlePrimary() {
    if (step === "welcome") {
      setStep("license");
    } else if (step === "license") {
      if (agreed) startInstall();
    } else if (step === "done") {
      // No real installer to launch — this is a UX preview, so we simply close it.
      onClose();
    }
  }

  function handleBack() {
    if (step === "license") setStep("welcome");
  }

  const idx = STEP_ORDER.indexOf(step);
  const progressRounded = Math.round(progress);
  const installTask =
    (TASK_THRESHOLDS.find(([threshold]) => progressRounded <= threshold) ??
      TASK_THRESHOLDS[TASK_THRESHOLDS.length - 1])[1];

  const backEnabled = step === "license";
  const primaryLabel =
    step === "welcome"
      ? "Continue"
      : step === "license"
        ? "Install"
        : step === "installing"
          ? "Installing…"
          : "Launch WeConnect";
  const primaryEnabled =
    step === "welcome" || (step === "license" && agreed) || step === "done";

  return (
    <div className="installer-card">
      <button className="modal-close" onClick={onClose} aria-label="Close installer preview">
        ✕
      </button>

      <div className="installer-side">
        <div className="installer-stripes" />
        <div>
          <div className="installer-brand">WECONNECT</div>
          <div className="installer-brand-sub">Shared Cockpit · Setup</div>
        </div>

        <div className="installer-steps">
          {STEP_ORDER.map((key, i) => {
            const done = i < idx;
            const active = i === idx;
            const markColor = done ? "var(--green)" : active ? "var(--accent)" : "var(--text-25)";
            const markBorder = done
              ? "rgba(74,222,128,.4)"
              : active
                ? "var(--accent)"
                : "var(--hairline)";
            const markBg = active ? "rgba(80,232,244,.08)" : "transparent";
            const labelColor = active ? "#fff" : done ? "var(--text-55)" : "var(--text-25)";
            return (
              <div className="installer-step-row" key={key}>
                <div
                  className="installer-step-mark"
                  style={{ color: markColor, borderColor: markBorder, background: markBg }}
                >
                  {done ? "✓" : i + 1}
                </div>
                <div className="installer-step-label" style={{ color: labelColor }}>
                  {STEP_LABELS[key]}
                </div>
              </div>
            );
          })}
        </div>

        <div>
          <div className="installer-version">V0.0.1</div>
          <div className="installer-copyright">© 2026 WeConnect</div>
        </div>
      </div>

      <div className="installer-content">
        {step === "welcome" && (
          <div className="installer-panel">
            <div className="installer-eyebrow">Welcome</div>
            <h1 className="installer-title">
              Install WeConnect
              <br />
              <span className="dim">on this PC</span>
            </h1>
            <p className="installer-lead">
              This will install the WeConnect shared-cockpit client and its Microsoft Flight
              Simulator bridge. Close MSFS before continuing.
            </p>
            <div className="installer-meta-row">
              <div className="installer-meta">
                <div className="installer-meta-label">Compatible with</div>
                <div className="installer-meta-value">MSFS 2020 &amp; 2024</div>
              </div>
              <div className="installer-meta">
                <div className="installer-meta-label">Platform</div>
                <div className="installer-meta-value">Windows 10 / 11 · 64-bit</div>
              </div>
            </div>
          </div>
        )}

        {step === "license" && (
          <div className="installer-panel">
            <div className="installer-eyebrow">License agreement</div>
            <div className="installer-license-box">
              <p>
                <strong>WeConnect End-User License Agreement</strong>
              </p>
              <p>
                This software is provided for private, non-commercial flight-simulation use. By
                installing WeConnect you agree to run it only alongside a legally licensed copy of
                Microsoft Flight Simulator 2020 or 2024.
              </p>
              <p>
                WeConnect synchronizes cockpit state between two connected pilots over the
                network. Session data (aircraft state, join codes, telemetry) is transmitted to
                the connected peer for the duration of a flight and is not sold to third parties.
              </p>
              <p>
                The software is supplied "as is", without warranty of any kind. The authors are
                not liable for any interruption to your simulator, add-ons, or saved flights.
              </p>
              <p>
                The SimConnect bridge component runs locally and requires MSFS to be installed.
                You may uninstall WeConnect at any time from Windows Settings.
              </p>
            </div>
            <button
              className="checkbox-row installer-checkbox"
              onClick={() => setAgreed((a) => !a)}
            >
              <div
                className="checkbox-box"
                style={{
                  borderColor: agreed ? "var(--accent)" : "rgba(199,248,254,.35)",
                  background: agreed ? "rgba(80,232,244,.1)" : "transparent",
                }}
              >
                {agreed ? "✓" : ""}
              </div>
              <span className="checkbox-label">I accept the terms of the license agreement</span>
            </button>
          </div>
        )}

        {step === "installing" && (
          <div className="installer-panel">
            <div className="installer-eyebrow">Installing</div>
            <h2 className="installer-h2">Setting up WeConnect…</h2>
            <div className="installer-progress-row">
              <div className="installer-progress-task">{installTask}</div>
              <div className="installer-progress-pct">{progressRounded}%</div>
            </div>
            <div className="bar-track" style={{ marginBottom: 26 }}>
              <div
                className="bar-fill"
                style={{ width: `${progressRounded}%`, boxShadow: "0 0 8px var(--accent)" }}
              />
            </div>
            <div className="installer-log">
              {LOG_STEPS.map(([threshold, text]) => {
                const complete = progressRounded >= threshold;
                return (
                  <div
                    className="installer-log-line"
                    key={text}
                    style={{ color: complete ? "var(--text-55)" : "var(--text-70)" }}
                  >
                    <span style={{ color: complete ? "var(--green)" : "var(--accent)" }}>
                      {complete ? "✓" : "›"}
                    </span>
                    <span>{text}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="installer-panel">
            <div className="installer-eyebrow done">Installation complete</div>
            <div className="installer-done-head">
              <div className="installer-done-icon">✓</div>
              <h2 className="installer-done-title">You're ready to fly</h2>
            </div>
            <p className="installer-lead" style={{ maxWidth: 360 }}>
              WeConnect V0.0.1 has been installed. Launch the app, create a session, and share the
              join code with your co-pilot.
            </p>
            <button
              className="checkbox-row installer-checkbox"
              style={{ marginTop: "auto" }}
              onClick={() => setShortcut((s) => !s)}
            >
              <div
                className="checkbox-box"
                style={{
                  borderColor: shortcut ? "var(--accent)" : "rgba(199,248,254,.35)",
                  background: shortcut ? "rgba(80,232,244,.1)" : "transparent",
                }}
              >
                {shortcut ? "✓" : ""}
              </div>
              <span className="checkbox-label">Create a desktop shortcut</span>
            </button>
          </div>
        )}

        <div className="installer-footer">
          <button
            className="installer-back-btn"
            onClick={handleBack}
            disabled={!backEnabled}
            style={{
              color: backEnabled ? "var(--text-70)" : "var(--text-25)",
              cursor: backEnabled ? "pointer" : "default",
            }}
          >
            ← Back
          </button>
          <button
            className={`installer-primary-btn${step === "done" ? " done" : ""}`}
            onClick={handlePrimary}
            disabled={!primaryEnabled}
            style={{
              opacity: primaryEnabled ? 1 : 0.4,
              cursor: primaryEnabled ? "pointer" : "not-allowed",
            }}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
