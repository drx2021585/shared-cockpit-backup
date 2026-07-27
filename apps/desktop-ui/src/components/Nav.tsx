import { NAV_ITEMS, type ViewId } from "../views/types";
import weConnectLogo from "../assets/we-connect-logo.png";

interface NavProps {
  active: ViewId;
  onNavigate: (view: ViewId) => void;
  sessionActive: boolean;
  partyCreated: boolean;
}

export function Nav({ active, onNavigate, sessionActive, partyCreated }: NavProps) {
  return (
    <div className="nav">
      <button className="nav-brand" onClick={() => onNavigate("home")}>
        <span className="brand-logo-crop brand-logo-crop-nav">
          <img src={weConnectLogo} alt="We Connect" />
        </span>
      </button>
      <div className="nav-links">
        {NAV_ITEMS.map((item) => {
          const locked =
            (sessionActive && (item.id === "party" || item.id === "join")) ||
            (partyCreated && item.id === "join");
          return (
            <button
              key={item.id}
              className={`${active === item.id ? "active" : ""}${locked ? " session-locked" : ""}`}
              onClick={() => onNavigate(item.id)}
              disabled={locked}
              aria-disabled={locked}
              title={locked ? "Ya tienes una party activa en In cockpit" : undefined}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
