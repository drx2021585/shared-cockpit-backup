import packageMetadata from "../package.json";

// Contenido extraído literalmente de renderVals() en el handoff de diseño
// (Shared Cockpit Plan.dc.html). Mantenido en inglés porque así está el diseño
// aprobado; cambiar el idioma es una decisión de producto aparte.
//
// NOTA: activeAircraft y cockpitSeats del diseño original se ELIMINARON de
// aquí — eran datos de relleno (Cessna 152/DA40 sin perfil real, "98%" y
// "32ms" inventados). Esos datos ahora vienen de verdad de server/api
// (ver src/lib/apiClient.ts y src/lib/useSessionSocket.ts). Lo que queda en
// este archivo es copy de marketing estático (textos de la landing), no
// datos operativos.

export interface FlowStep {
  label: string;
  hasNext: boolean;
}

export const heroTags = [
  "MSFS 2020 & 2024 · Windows PC",
  "2 players in 1 cockpit",
  "No extra downloads for your friend — just a code",
];

const flowLabels = [
  "Create a session",
  "Generate a 6-character code",
  "Send it to your friend",
  "They enter it and join",
  "App checks you're both flying the same plane",
  "You're in the same cockpit",
];

export const flowSteps: FlowStep[] = flowLabels.map((label, i) => ({
  label,
  hasNext: i < flowLabels.length - 1,
}));

export const scopeIn = [
  "Two pilots, one aircraft",
  "Private session with a join code",
  "Captain & first officer seats",
  "Full flight-control handoff",
  "A heads-up when something looks out of sync",
  "Automatic reconnection if someone drops",
];

export const scopeOut = [
  "Screen sharing or video",
  "Built-in voice chat",
  "Public matchmaking / big lobbies",
  "More than 2 players",
  "Instructor-triggered failures",
  "Every aircraft on day one",
  "Full airliner FMC/MCDU sharing",
  "Xbox",
  "Shared custom weather",
];

export interface ScreenCard {
  title: string;
  tag: string;
  subtitle: string;
  items: string[];
}

export const screens: ScreenCard[] = [
  {
    title: "Home",
    tag: "CONNECT",
    subtitle: "The first thing you see when you open the app.",
    items: [
      "Simulator connection status",
      "Aircraft currently loaded",
      "Compatibility score for that aircraft",
      "Create session / Join session",
    ],
  },
  {
    title: "Create session",
    tag: "HOST",
    subtitle: "Set up before your friends joins.",
    items: [
      "Session name",
      "Private join code (auto-generated)",
      "Optional password",
      "Your starting seat: captain or first officer",
    ],
  },
  {
    title: "Join session",
    tag: "GUEST",
    subtitle: "For the second pilot.",
    items: ["Enter the code", "Aircraft match check", "Confirm and load into the shared flight"],
  },
  {
    title: "Shared cockpit",
    tag: "IN-FLIGHT",
    subtitle: "The main screen while you're flying together.",
    items: [
      "Who's in each seat",
      "Who currently has the controls",
      "Connection quality (ping)",
      "Request controls / hand off controls",
    ],
  },
  {
    title: "Aircraft",
    tag: "SETUP",
    subtitle: "Manage which planes are ready to fly together.",
    items: ["Installed aircraft & compatibility %"],
  },
  {
    title: "Flight diagnostics",
    tag: "IN-FLIGHT",
    subtitle: "Simple health check, not raw data.",
    items: [
      '"Everything is in sync" indicator',
      "What's currently out of sync, in plain terms",
      "Resync button",
      "Send a report if something felt wrong",
    ],
  },
];

export const authorityRows = [
  { name: "Flight controls (yoke, rudder, throttle)", mode: "one pilot at a time" },
  { name: "Switches & lights", mode: "either seat" },
  { name: "Radios & autopilot", mode: "either seat" },
  { name: "Aircraft position & physics", mode: "flying pilot only" },
];

export const transferSteps = [
  'First officer taps "Request controls"',
  "Captain accepts",
  "Both control inputs are checked so nothing jerks",
  "Controls hand over cleanly",
  "Both cockpits confirm who's flying",
];

export const reliability = [
  {
    title: "Auto-reconnect",
    desc: "A dropped Wi-Fi connection resumes the flight instead of ending the session.",
  },
  {
    title: "Conflict-safe switches",
    desc: "Flip a switch in both cockpits at once and the app resolves it to one correct state — no flickering.",
  },
  {
    title: "Drift correction",
    desc: "Both sims fly the same physics; the app only nudges things back in line if the two cockpits disagree.",
  },
];

export const learnSteps = [
  "Pick the aircraft you want supported",
  "Fly it once while the app watches what changes",
  "Confirm the switches and gauges it found",
  "Test that they sync correctly",
  "Save it as a ready-to-fly profile",
];

export const requirements = [
  "Windows 10 or 11",
  "MSFS 2020 or 2024",
  "The Shared Cockpit app installed",
  "The same aircraft as your friend, plus an internet connection",
];

export const accentColor = "#50e8f4";

// ---------------------------------------------------------------------------
export const currentVersion = packageMetadata.version;
