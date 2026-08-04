import {
  heroTags,
  flowSteps,
  screens,
  reliability,
  currentVersion,
} from "../data";

export function Home() {
  return (
    <>
      {/* HERO */}
      <div className="section" style={{ paddingTop: 40, paddingBottom: 36 }}>
        <div className="eyebrow" style={{ marginBottom: 30 }}>
          For pilots who fly together
        </div>
        <h1 className="hero-title">
          Two pilots. One cockpit.
          <br />
          <span className="dim">One shared sky.</span>
        </h1>
        <p className="hero-lead">
          Fly the same aircraft in Microsoft Flight Simulator with a friend — one of you in the
          left seat, one in the right. Every switch, radio call and control input is shared, live,
          between both cockpits.
        </p>
        <div className="hero-tags">
          {heroTags.map((tag) => (
            <div className="hero-tag" key={tag}>
              {tag}
            </div>
          ))}
        </div>
      </div>

      {/* HOW IT STARTS */}
      <div className="section">
        <div className="section-top">
          <div className="mono-label" style={{ marginBottom: 44 }}>
            Getting into the same cockpit
          </div>
          <div className="flow-row">
            {flowSteps.map((step, i) => (
              <div className="flow-step" key={step.label}>
                <div className="flow-step-content">
                  <div className="flow-step-num">0{i + 1}</div>
                  <div className="flow-step-label">{step.label}</div>
                </div>
                {step.hasNext && <div className="flow-connector" />}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* SCREENS */}
      <div className="section" id="screens">
        <div className="section-head section-top">
          <span className="index-num">01</span>
          <h2 className="h2">Inside the app</h2>
        </div>
        <p className="lead" style={{ maxWidth: 560 }}>
          The app flow is reduced to the two actions that matter before the flight starts.
        </p>
        <div className="grid-2-tight">
          {screens.map((s) => (
            <div className="screen-card" key={s.title}>
              <div className="screen-card-head">
                <div className="screen-card-title">{s.title}</div>
                <div className="screen-card-tag">{s.tag}</div>
              </div>
              <div className="screen-card-sub">{s.subtitle}</div>
              <div className="screen-card-items">
                {s.items.map((it) => (
                  <div className="screen-card-item" key={it}>
                    {it}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* STAYING IN SYNC (reliability) */}
      <div className="section">
        <div className="section-head section-top">
          <span className="index-num">02</span>
          <h2 className="h2">Staying in sync</h2>
        </div>
        <p className="lead" style={{ maxWidth: 560 }}>
          Wi-Fi drops. Switches get flipped in both cockpits at once. The app is built to notice
          and fix that without either pilot doing anything.
        </p>
        <div className="grid-3">
          {reliability.map((r) => (
            <div key={r.title}>
              <div className="reliability-title">{r.title}</div>
              <div className="reliability-desc">{r.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* CTA / v1 */}
      <div className="section">
        <div className="cta">
          <div className="cta-version">APP VERSION / We Connect v{currentVersion}</div>
          <div className="cta-copyright">© 2026 We Connect. All rights reserved.</div>
        </div>
      </div>
    </>
  );
}
