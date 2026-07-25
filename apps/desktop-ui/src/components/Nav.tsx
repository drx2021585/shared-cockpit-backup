import { NAV_ITEMS, type ViewId } from "../views/types";

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
        <span>WECONNECT</span>
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
