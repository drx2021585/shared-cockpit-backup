import { useEffect, useState } from "react";
import { Nav } from "./components/Nav";
import { UpdateModal } from "./components/UpdateModal";
import { FirstLaunchSetup } from "./components/FirstLaunchSetup";
import { TitleBar } from "./components/TitleBar";
import { Home } from "./views/Home";
import { Download } from "./views/Download";
import { Aircraft } from "./views/Aircraft";
import { Party } from "./views/Party";
import { Join } from "./views/Join";
import { Cockpit } from "./views/Cockpit";
import { Profile } from "./views/Profile";
import type { ViewId } from "./views/types";
import type { Session } from "./lib/apiClient";
import { prefetchAircraftProfiles } from "./lib/useAircraftProfiles";

const PILOT_NAME_STORAGE_KEY = "weconnect.pilotName";

export function App() {
  const [view, setView] = useState<ViewId>("home");
  const [pilotName, setPilotName] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(PILOT_NAME_STORAGE_KEY) ?? "";
  });
  const [createdSession, setCreatedSession] = useState<Session | null>(null);
  const [createdSessionPilotName, setCreatedSessionPilotName] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [sessionPilotName, setSessionPilotName] = useState<string | null>(null);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [showFirstLaunchSetup, setShowFirstLaunchSetup] = useState(false);
  const [communityPath, setCommunityPath] = useState<string | null>(null);

  useEffect(() => {
    prefetchAircraftProfiles();
  }, []);

  useEffect(() => {
    const setup = window.weconnectSetup;
    if (!setup) return; // build web puro: no hay carpeta Community que pedir
    setup.getConfig().then((config) => {
      setCommunityPath(config.communityPath);
      if (!config.firstLaunchCompleted) setShowFirstLaunchSetup(true);
    });
  }, []);

  useEffect(() => {
    window.localStorage.setItem(PILOT_NAME_STORAGE_KEY, pilotName);
  }, [pilotName]);

  useEffect(() => {
    // electron/main.cjs hace un chequeo silencioso al abrir la app
    // (app.isPackaged) y lo publica por este mismo canal — si encuentra una
    // versión nueva, se abre el modal solo, sin que el usuario tenga que ir
    // a "Check for updates" a mano. No existe en el build web puro.
    const bridge = (window as unknown as { weconnectUpdater?: { onEvent: (cb: (p: { status: string }) => void) => () => void } })
      .weconnectUpdater;
    if (!bridge) return;
    return bridge.onEvent((payload) => {
      if (payload.status === "available") setUpdateModalOpen(true);
    });
  }, []);

  function handleSessionReady(session: Session, name: string) {
    setCreatedSession(null);
    setCreatedSessionPilotName(null);
    setActiveSession(session);
    setPilotName(name);
    setSessionPilotName(name);
    setView("cockpit");
  }

  function handleSessionCreated(session: Session, name: string) {
    setCreatedSession(session);
    setCreatedSessionPilotName(name);
    setPilotName(name);
  }

  function handleNavigate(nextView: ViewId) {
    if (activeSession && (nextView === "party" || nextView === "join")) {
      return;
    }
    if (createdSession && nextView === "join") {
      return;
    }
    setView(nextView);
  }

  function handleSessionClosed() {
    setActiveSession(null);
    setSessionPilotName(null);
    setView("home");
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
          <Party
            pilotName={createdSessionPilotName ?? pilotName}
            onPilotNameChange={setPilotName}
            createdSession={createdSession}
            onSessionCreated={handleSessionCreated}
            onSessionReady={handleSessionReady}
          />
        );
      case "join":
        return (
          <Join pilotName={pilotName} onPilotNameChange={setPilotName} onSessionReady={handleSessionReady} />
        );
      case "cockpit":
        return null;
      case "profile":
        return (
          <Profile
            pilotName={pilotName}
            onPilotNameChange={setPilotName}
            onCheckForUpdates={() => setUpdateModalOpen(true)}
            communityPath={communityPath}
            onChangeFlightSimFolder={() => setShowFirstLaunchSetup(true)}
          />
        );
    }
  }

  return (
    <div
      className={window.weconnectWindow ? "has-titlebar" : undefined}
      style={{ background: "var(--bg)", color: "var(--text)" }}
    >
      <TitleBar />
      <Nav
        active={view}
        onNavigate={handleNavigate}
        sessionActive={activeSession !== null}
        partyCreated={createdSession !== null}
      />
      {view !== "cockpit" && renderView()}
      {activeSession ? (
        <div style={{ display: view === "cockpit" ? "block" : "none" }}>
          <Cockpit
            joinCode={activeSession.joinCode}
            pilotName={sessionPilotName}
            initialSession={activeSession}
            onSessionClosed={handleSessionClosed}
          />
        </div>
      ) : (
        view === "cockpit" && <Cockpit joinCode={null} pilotName={null} />
      )}
      <UpdateModal open={updateModalOpen} onClose={() => setUpdateModalOpen(false)} />
      {showFirstLaunchSetup && (
        <FirstLaunchSetup
          onClose={() => setShowFirstLaunchSetup(false)}
          onCompleted={(path) => {
            setCommunityPath(path);
            setShowFirstLaunchSetup(false);
          }}
        />
      )}
    </div>
  );
}
