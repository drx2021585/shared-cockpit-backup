export type ViewId = "home" | "download" | "aircraft" | "party" | "join" | "cockpit" | "profile";

export const NAV_ITEMS: { id: ViewId; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "party", label: "Create a party" },
  { id: "join", label: "Join a party" },
  { id: "cockpit", label: "In cockpit" },
  { id: "aircraft", label: "Aircraft" },
  { id: "profile", label: "My profile" },
];
