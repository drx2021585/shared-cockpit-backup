import { NAV_ITEMS, type ViewId } from "../views/types";

interface NavProps {
  active: ViewId;
  onNavigate: (view: ViewId) => void;
}

export function Nav({ active, onNavigate }: NavProps) {
  return (
    <div className="nav">
      <button className="nav-brand" onClick={() => onNavigate("home")}>
        <span>WECONNECT</span>
      </button>
      <div className="nav-links">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            className={active === item.id ? "active" : ""}
            onClick={() => onNavigate(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
