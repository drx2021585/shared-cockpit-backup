import { useAircraftProfiles } from "../lib/useAircraftProfiles";
import type { AircraftProfile } from "../lib/apiClient";

/**
 * Estado derivado de la cobertura real (no una etiqueta inventada por
 * aeronave): >=80% listo para volar, 40-79% soporte parcial, <40% soporte
 * temprano. El umbral es arbitrario pero la fuente (coverage) es real.
 *
 * OJO al leer esto junto al badge de "not tested": coverage mide completitud
 * MECÁNICA (cuántos controles sincronizan en ambos sentidos), no si el perfil
 * se voló alguna vez. Por eso un perfil generado a máquina puede tener más
 * cobertura que uno probado en vivo, y por eso "no probado" se muestra como
 * etiqueta separada en vez de descontarse del porcentaje — descontarlo
 * escondería la diferencia en un solo número que no dice cuál de las dos cosas
 * falta.
 */
function statusFor(coverage: number): { label: string; color: string } {
  if (coverage >= 80) return { label: "Ready to fly", color: "#4ade80" };
  if (coverage >= 40) return { label: "Partial support", color: "#50e8f4" };
  return { label: "Early support", color: "rgba(199,248,254,0.4)" };
}

function describeCapabilities(profile: AircraftProfile): string {
  if (profile.availability === "soon") {
    return "Profile preview only. This aircraft is planned for We Connect, but players cannot use it in shared cockpit yet.";
  }
  const levels = Object.values(profile.capabilities);
  const hasFullSync = levels.includes("full");
  const hasPartialSync = levels.includes("partial");

  const parts: string[] = [];
  if (hasFullSync) {
    parts.push(
      "Full sync: All supported controls and switches synchronize with your co-pilot and function as expected."
    );
  }
  if (hasPartialSync) {
    parts.push(
      "Partial sync: Some controls and switches may not synchronize reliably yet. Full synchronization is coming in a future update."
    );
  }
  return parts.join(" ") || "No systems mapped yet.";
}

export function Aircraft() {
  const { profiles, loading, error } = useAircraftProfiles();

  return (
    <div className="section" style={{ paddingTop: 32, paddingBottom: 64 }}>
      <div className="section-head" style={{ marginBottom: 10 }}>
        <h2 className="h2-sm">Aircraft</h2>
      </div>
      <p className="lead" style={{ maxWidth: 560 }}>
        Aircraft profiles taught to the app so far, with compatibility computed from
        each profile's actual system coverage.
      </p>

      {loading && <p style={{ color: "var(--text-45)", fontSize: 13 }}>Loading aircraft catalog…</p>}
      {error && (
        <p style={{ color: "var(--red, #e24c4b)", fontSize: 13, maxWidth: 480 }}>{error}</p>
      )}
      {!loading && !error && profiles.length === 0 && (
        <p style={{ color: "var(--text-45)", fontSize: 13 }}>
          No aircraft profiles have been added yet.
        </p>
      )}

      <div className="grid-2">
        {profiles.map((ac) => {
          const status = statusFor(ac.coverage);
          const isNew = ac.id === "ifly-737-max8";
          const isSoon = ac.availability === "soon";
          return (
            <div key={ac.id} className="aircraft-card">
              <div className="aircraft-card-head">
                <div className="aircraft-card-name-wrap">
                  <div className="aircraft-card-name">{ac.name}</div>
                  {isNew && <span className="aircraft-card-badge-new">New</span>}
                  {isSoon && <span className="aircraft-card-badge-soon">Soon</span>}
                </div>
                <div className="aircraft-card-pct">{ac.coverage}%</div>
              </div>
              <div className="status-line">
                <span className="status-dot" style={{ background: status.color }} />
                <span className="status-label" style={{ color: status.color }}>
                  {status.label}
                </span>
              </div>
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${ac.coverage}%` }} />
              </div>
              <div className="aircraft-card-desc">{describeCapabilities(ac)}</div>
              {ac.variants && ac.variants.length > 0 && (
                <div className="aircraft-variants">
                  <div className="aircraft-variants-title">
                    Works with {ac.variants.length} models
                  </div>
                  <ul className="aircraft-variants-list">
                    {ac.variants.map((variant) => (
                      <li key={variant}>{variant}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
