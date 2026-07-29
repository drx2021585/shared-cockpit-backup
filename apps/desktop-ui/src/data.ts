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

export interface VersionHistoryEntry {
  version: string;
  title: string;
  date?: string;
  commits: string[];
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
      "Your starting seat: captain, first officer, or observer",
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
  "The We Connect app installed",
  "The same aircraft as your friend, plus an internet connection",
];

export const accentColor = "#50e8f4";

// ---------------------------------------------------------------------------
export const currentVersion = packageMetadata.version;

export const versionHistory: VersionHistoryEntry[] = [
  {
    version: "0.1.12",
    title: "Current build",
    commits: [
      "Fixed the main reason switches stopped syncing partway through a shared session. When you joined, the app tried to copy your partner's entire cockpit onto yours — about a thousand switches at once, even the ones already in the same position — which jammed the connection to the simulator for minutes. It now skips any switch that is already where your partner has it.",
    ],
  },
  {
    version: "0.1.11",
    title: "Published release",
    date: "2026-07-29",
    commits: [
      "Each aircraft card now lists the exact models the profile works with. The iFly B737 MAX 8 covers four of them: the base model, the 166 and 189 seat layouts, and the MAX 8-200.",
    ],
  },
  {
    version: "0.1.10",
    title: "Published release",
    date: "2026-07-29",
    commits: [
      "The iFly B737 MAX 8 now synchronizes the flight controls — the control column and the ailerons were confirmed moving in the simulator, and only one pilot flies at a time.",
      "Switches with several positions, like the autobrake selector, now reach the position the other pilot chose. Before, they stopped one notch short or never moved at all.",
      "The APU switch was corrected after testing it in the simulator: it was sending the wrong command and turned the APU off when asked to start it.",
      "If a control moves the wrong way, the app now notices and stops instead of pushing it further in the wrong direction.",
      "The simulator connection is far more robust: a single unreadable cockpit variable used to shut the whole connection down mid-flight, and now it just skips that one control and keeps going.",
      "When an aircraft profile can't be loaded, the app now says so by name, instead of leaving you with a confusing 'aircraft not recognized' message.",
    ],
  },
  {
    version: "0.1.9",
    title: "Published release",
    date: "2026-07-28",
    commits: [
      "The iFly B737 MAX 8 was added to the aircraft list, with over a thousand cockpit controls mapped for shared-cockpit use. It hasn't been tested in the simulator yet, and the app now says so on the aircraft card.",
      "The PMDG profile now covers the whole 737 NG family — the 600, 700, 800, 900 and 900ER, including the cargo variants — instead of only the 900.",
      "Each aircraft now shows its own coverage figure, measured from the controls that actually synchronize in both directions. Before, two aircraft could show the same percentage even when one had far more of its cockpit mapped.",
      "The Cessna 172 was removed from the aircraft list for now.",
      "We Connect now shows its own logo on the desktop shortcut and in the installer, not just in the running window.",
      "The aircraft list loads faster, because the app starts fetching it as soon as it opens instead of waiting until you open the Aircraft screen.",
      "The profile screen gained a version history you can expand to see what changed in each release.",
    ],
  },
  {
    version: "0.1.8",
    title: "Published release",
    date: "2026-07-27",
    commits: [
      "The app now looks cleaner by hiding the visible scrollbars while keeping normal scrolling exactly the same.",
      "We Connect now shows its own logo correctly in the running desktop window and taskbar.",
      "Connection handling was updated behind the scenes to keep the online service more stable.",
      "Infrastructure updates were made to support a smoother and more maintainable live service.",
    ],
  },
  {
    version: "0.1.4",
    title: "Published release",
    date: "2026-07-27",
    commits: [
      "We Connect now prepares the simulator connection automatically when the app opens, so there are fewer setup steps before flying.",
      "Version 0.1.4 was published with improvements focused on making aircraft data reading more reliable.",
      "Switch and cockpit state reading for the PMDG 737 was improved to make shared-cockpit synchronization more dependable.",
    ],
  },
  {
    version: "0.1.3",
    title: "Published release",
    date: "2026-07-27",
    commits: [
      "Version 0.1.3 was published as a major step forward for the desktop app.",
      "The PMDG 737 gained real shared-cockpit switch synchronization, making cockpit actions carry over more accurately between both pilots.",
      "The Windows app now supports in-app updates, so new versions can be installed more easily.",
      "We Connect gained its first real live connection between the app and the simulator for shared-cockpit use.",
      "The online service was upgraded to support real shared sessions between pilots on different computers.",
      "The desktop installer was improved so the app works more like a complete standalone product.",
      "Support was added for the PMDG 737-900 and 737-900ER.",
      "We Connect became available as a proper Windows desktop application.",
    ],
  },
  {
    version: "0.1.0",
    title: "Initial release",
    date: "2026-07-24",
    commits: [
      "This was the first foundation release for We Connect and the starting point of the project.",
    ],
  },
];
