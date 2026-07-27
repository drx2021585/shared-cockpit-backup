import { useAircraftProfiles } from "../lib/useAircraftProfiles";
import type { AircraftProfile } from "../lib/apiClient";

/**
 * Estado derivado de la cobertura real (no una etiqueta inventada por
 * aeronave): >=80% listo para volar, 40-79% soporte parcial, <40% soporte
 * temprano. El umbral es arbitrario pero la fuente (coverage) es real.
 */
function statusFor(coverage: number): { label: string; color: string } {
  if (coverage >= 80) return { label: "Ready to fly", color: "#4ade80" };
  if (coverage >= 40) return { label: "Partial support", color: "#50e8f4" };
  return { label: "Early support", color: "rgba(199,248,254,0.4)" };
}

function describeCapabilities(profile: AircraftProfile): string {
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
      <div className="section-head section-top" style={{ marginBottom: 10 }}>
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
          return (
            <div key={ac.id}>
              <div className="aircraft-card-head">
                <div className="aircraft-card-name">{ac.name}</div>
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
