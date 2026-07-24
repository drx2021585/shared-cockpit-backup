import { useState } from "react";
import { Nav } from "./components/Nav";
import { UpdateModal } from "./components/UpdateModal";
import { Home } from "./views/Home";
import { Download } from "./views/Download";
import { Aircraft } from "./views/Aircraft";
import { Party } from "./views/Party";
import { Join } from "./views/Join";
import { Cockpit } from "./views/Cockpit";
import { Profile } from "./views/Profile";
import type { ViewId } from "./views/types";
import type { Session } from "./lib/apiClient";

export function App() {
  const [view, setView] = useState<ViewId>("home");
  const [pilotName, setPilotName] = useState("");
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);

  function handleSessionReady(session: Session, name: string) {
    setActiveSession(session);
    setPilotName(name);
    setView("cockpit");
  }

  function renderView() {
    switch (view) {
      case "home":
        return <Home />;
      case "download":
        return <Download />;
      case "aircraft":
        return <Aircraft />;
      case "party":
        return (
          <Party pilotName={pilotName} onPilotNameChange={setPilotName} onSessionReady={handleSessionReady} />
        );
      case "join":
        return (
          <Join pilotName={pilotName} onPilotNameChange={setPilotName} onSessionReady={handleSessionReady} />
        );
      case "cockpit":
        return <Cockpit joinCode={activeSession?.joinCode ?? null} pilotName={pilotName || null} />;
      case "profile":
        return (
          <Profile
            pilotName={pilotName}
            onPilotNameChange={setPilotName}
            onCheckForUpdates={() => setUpdateModalOpen(true)}
          />
        );
    }
  }

  return (
    <div style={{ background: "var(--bg)", color: "var(--text)" }}>
      <Nav active={view} onNavigate={setView} />
      {renderView()}
      <UpdateModal open={updateModalOpen} onClose={() => setUpdateModalOpen(false)} />
    </div>
  );
}
