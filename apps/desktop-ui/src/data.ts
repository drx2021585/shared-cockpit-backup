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
    version: "0.1.36",
    title: "Current build",
    date: "2026-07-31",
    commits: [
      "The Session relay area is now organized around the current active route, with a clearer split between the hosted relay and a self-hosted direct/LAN relay.",
      "A new Use this PC as host action fills and activates the suggested local relay address automatically, instead of making the user copy it by hand.",
      "The embedded simulator bridge now ships with the same version as the desktop app again, which unblocks desktop releases from publishing the updater files that players need.",
    ],
  },
  {
    version: "0.1.22",
    title: "Published release",
    date: "2026-07-31",
    commits: [
      "Fixed a packaging failure that could ship the desktop app without its embedded local bridge. When that happened, the cockpit stayed stuck on \"Local bridge: Disconnected\" and never received any simulator data.",
      "The desktop app now relaunches the local bridge if it dies unexpectedly, instead of leaving the flight screen permanently disconnected from the simulator.",
      "Bridge reconnects now request a fresh auth token each time, so a restarted bridge can be reached again without forcing the whole app into a broken stale-token state.",
      "The desktop release pipeline now refuses to publish if the embedded bridge executable or SimConnect.dll are missing, preventing another broken installer from reaching players.",
    ],
  },
  {
    version: "0.1.21",
    title: "Published release",
    date: "2026-07-31",
    commits: [
      "Flight-position synchronization is now much more precise: instead of snapping to the other pilot's aircraft coordinates, We Connect corrects using local meter-based error, short extrapolation and separate limits for horizontal movement, altitude and attitude.",
      "The app now enforces minimum compatibility across the whole stack: app to bridge and app to server/API. If your build is too old, the session is blocked before a mismatched cockpit can form.",
      "The required-update flow is now explicit and actionable. When an update is mandatory, the modal tells you and lets you restart We Connect directly instead of leaving you in a dead-end state.",
      "Aircraft mismatch checks now say exactly what differs between both pilots: aircraft, variant, simulator version or app version.",
      "Crew roles are now clearer inside the session, with explicit captain and first officer ownership for who can hold and transfer the flight controls.",
    ],
  },
  {
    version: "0.1.20",
    title: "Published release",
    date: "2026-07-31",
    commits: [
      "The cockpit now renders shared CDU-style screens from the other PC instead of receiving the data and leaving it invisible, which closes the loop for PMDG read-only display mirroring.",
      "Session health is now tracked per link: the app tells you whether the relay, your local bridge, your peer's flight data and the shared display feed are healthy, stale or disconnected.",
      "After a reconnect, We Connect now re-publishes your current controls and read-only screens automatically so both cabins converge again without waiting for the next button press.",
      "The Community package updater no longer trusts only package_version. It now compares the real package contents, so a new WASM build reaches players even if someone forgot to bump the version string.",
      "Aircraft compatibility scoring was expanded to count real systems that were previously hidden behind a generic average, and the iFly 737 MAX 8 now reports much higher coverage based on its actual mapped cockpit.",
      "Profile validation now fails if manifest.yaml and capabilities.yaml drift apart, preventing the UI from showing one compatibility story while the documentation claims another.",
    ],
  },
  {
    version: "0.1.18",
    title: "Published release",
    date: "2026-07-30",
    commits: [
      "The cockpit now shows a confirmation popup as soon as both pilots are using the same aircraft and simulator version.",
      "The matched-aircraft state is tracked as a real transition, so the confirmation appears once when the setup becomes valid instead of flickering on every refresh.",
      "The Network panel now shows the real IPv4 and IPv6 addresses from this PC instead of public web IP lookups, and first-time setup blocks until FSUIPC7 is installed correctly.",
    ],
  },
  {
    version: "0.1.16",
    title: "Published release",
    commits: [
      "Buttons now actually reach your co-pilot. We measured it in the simulator: the app was only looking at the cockpit about 1.6 times per second, while a button press lasts about a tenth of a second — so most presses happened between two glances and were never seen at all. Out of six presses of a CDU key, four were lost. The app now watches 22 times per second instead, and all six get through.",
      "This was the main reason switches and buttons felt unreliable, above every other fix in the previous versions. Latching switches like the battery or the packs always worked because they stay in their new position; momentary buttons — the CDU keypad, the autopilot panel — spring back and were being missed.",
      "The connection to the simulator is also far lighter: instead of asking for each of the aircraft's thousand cockpit variables one by one, several times a second, the app now simply gets told what changed.",
    ],
  },
  {
    version: "0.1.14",
    title: "Published release",
    date: "2026-07-30",
    commits: [
      "Switches that moved the wrong way now fix themselves. Some cockpit selectors were wired backwards, so asking for one position moved them to the opposite one. The app now notices, corrects the direction, retries, and remembers — so each control gets it right from then on, on every future flight.",
      "Buttons on the CDU keypad, the autopilot panel and the warning panels were badly broken and are now fixed. A single press from your co-pilot could type the same key up to nine times; buttons could stay stuck down instead of springing back; and a quick double tap lost the second press. All of it affected around 580 controls.",
      "A new \"Download report\" button in the cockpit saves everything needed to diagnose a session that isn't syncing: which switches failed and why, what arrived from your co-pilot, and whether FSUIPC7 is set up correctly. Both pilots can download one and send them over.",
      "The first-time setup now checks for FSUIPC7 and warns you if it's missing or incomplete. It's required for add-on cockpits like the iFly 737 MAX 8 and the PMDG 737 to synchronize at all, and until now nothing told you that.",
      "The setup screen no longer claims to be downloading files and optimizing databases while it copies a single local file, and it no longer makes you wait two and a half seconds for show.",
      "The simulator package We Connect installs is now replaced automatically when a new version of the app ships one. Before, it was copied once on the very first launch and never updated again, so improvements to it never reached anyone who had already installed the app.",
      "That same package declared a minimum simulator version that excluded MSFS 2024 outright, and shipped with a placeholder file size that could make the simulator reject it. Both are fixed.",
    ],
  },
  {
    version: "0.1.13",
    title: "Published release",
    date: "2026-07-29",
    commits: [
      "When a switch fails to follow your partner, the app now says whether it moved and fell short or never moved at all. The second case points at a specific wiring mistake in the aircraft profile, so these reports can now be turned into fixes instead of guesses.",
    ],
  },
  {
    version: "0.1.12",
    title: "Published release",
    date: "2026-07-29",
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
