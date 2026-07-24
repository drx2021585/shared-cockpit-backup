import {
  heroTags,
  flowSteps,
  scopeIn,
  scopeOut,
  screens,
  authorityRows,
  transferSteps,
  reliability,
  learnSteps,
} from "../data";
import { useAircraftProfiles } from "../lib/useAircraftProfiles";

export function Home() {
  const { profiles, loading } = useAircraftProfiles();
  const featuredAircraft = profiles[0];

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

      {/* FEATURES / SCOPE */}
      <div className="section" id="features">
        <div className="section-head section-top">
          <span className="index-num">01</span>
          <h2 className="h2">What you can do together</h2>
        </div>
        <p className="lead" style={{ maxWidth: 520 }}>
          Version 1 is built around flying one aircraft together, start to finish — not around
          streaming, chat, or crowds.
        </p>
        <div className="grid-2">
          <div>
            <div className="mono-label" style={{ color: "var(--accent)", marginBottom: 24 }}>
              Works today
            </div>
            <div>
              {scopeIn.map((item) => (
                <div className="scope-item in" key={item}>
                  <span className="scope-mark in">✓</span>
                  {item}
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="mono-label" style={{ marginBottom: 24 }}>
              Not yet
            </div>
            <div>
              {scopeOut.map((item) => (
                <div className="scope-item out" key={item}>
                  <span className="scope-mark out">–</span>
                  {item}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* SCREENS */}
      <div className="section" id="screens">
        <div className="section-head section-top">
          <span className="index-num">02</span>
          <h2 className="h2">Inside the app</h2>
        </div>
        <p className="lead" style={{ maxWidth: 560 }}>
          Every screen answers one question the pilot has in the moment — am I connected, who's
          flying, and is anything out of sync.
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

      {/* ROLES & TRANSFER */}
      <div className="section" id="roles">
        <div className="section-head section-top">
          <span className="index-num">03</span>
          <h2 className="h2">Handing off the controls</h2>
        </div>
        <p className="lead" style={{ maxWidth: 560 }}>
          Only one pilot flies the aircraft at a time. Everything else — radios, lights, autopilot
          — can be worked by either seat at once, without stepping on each other.
        </p>
        <div className="mono-label" style={{ marginBottom: 26 }}>
          Who controls what
        </div>
        <div className="grid-2" style={{ alignItems: "start" }}>
          <div>
            {authorityRows.map((row) => (
              <div className="authority-row" key={row.name}>
                <div className="authority-name">{row.name}</div>
                <div className="authority-mode">{row.mode}</div>
              </div>
            ))}
          </div>
          <div>
            {transferSteps.map((step, i) => (
              <div className="transfer-step" key={step}>
                <div className="transfer-step-num">0{i + 1}</div>
                <div className="transfer-step-label">{step}</div>
              </div>
            ))}
            <div className="transfer-callout">"I HAVE CONTROL"</div>
          </div>
        </div>
      </div>

      {/* STAYING IN SYNC (reliability) */}
      <div className="section">
        <div className="section-head section-top">
          <span className="index-num">04</span>
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

      {/* AIRCRAFT SUPPORT */}
      <div className="section">
        <div className="section-head section-top">
          <span className="index-num">05</span>
          <h2 className="h2">Aircraft support</h2>
        </div>
        <p className="lead" style={{ maxWidth: 560 }}>
          Each aircraft needs to be taught to the app once. You'll always see how well-supported a
          plane is before you fly it.
        </p>
        <div className="grid-2">
          <div>
            <div className="mono-label" style={{ marginBottom: 24 }}>
              Adding a new aircraft
            </div>
            {learnSteps.map((step, i) => (
              <div className="learn-step" key={step}>
                <div className="learn-step-num">0{i + 1}</div>
                <div className="learn-step-label">{step}</div>
              </div>
            ))}
          </div>
          <div>
            {loading && <div className="aircraft-card-desc">Loading…</div>}
            {!loading && featuredAircraft && (
              <>
                <div className="aircraft-card-head">
                  <div className="aircraft-card-name">{featuredAircraft.name}</div>
                  <div className="aircraft-card-pct">{featuredAircraft.coverage}%</div>
                </div>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${featuredAircraft.coverage}%` }} />
                </div>
                <div className="aircraft-card-desc">
                  {featuredAircraft.developer} · v{featuredAircraft.version} · MSFS{" "}
                  {featuredAircraft.compatibility.msfs2020 && "2020"}
                  {featuredAircraft.compatibility.msfs2020 && featuredAircraft.compatibility.msfs2024 && " & "}
                  {featuredAircraft.compatibility.msfs2024 && "2024"}
                </div>
              </>
            )}
            {!loading && !featuredAircraft && (
              <div className="aircraft-card-desc">No aircraft profile available yet.</div>
            )}
          </div>
        </div>
      </div>

      {/* CTA / v1 */}
      <div className="section">
        <div className="cta">
          <div className="cta-version">First release · V0.0.1</div>
          <div className="cta-copyright">© 2026 WeConnect. All rights reserved.</div>
        </div>
      </div>
    </>
  );
}
