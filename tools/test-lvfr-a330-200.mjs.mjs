import { readFileSync, readdirSync, existsSync } from "node:fs";
  import { join, resolve } from "node:path";
  import { parse as parseYaml } from "yaml";

  const ROOT = resolve(process.cwd());
  const PROFILES_DIR = join(ROOT, "aircraft-profiles");

  function loadProfile(profileId) {
    const manifestPath = join(PROFILES_DIR, profileId, "manifest.yaml");
    const detectionPath = join(PROFILES_DIR, profileId, "detection.yaml");

    if (!existsSync(manifestPath)) {
      throw new Error(`No existe ${manifestPath}`);
    }

    const manifest = parseYaml(readFileSync(manifestPath, "utf8"));
    const detection = existsSync(detectionPath)
      ? parseYaml(readFileSync(detectionPath, "utf8"))
      : {};

    return { manifest, detection };
  }

  function profileMatchesTitle(profile, title) {
    const rules = profile.detection?.titleContains ?? [];
    const normalizedTitle = String(title).toLowerCase();

    return rules.some((rule) => normalizedTitle.includes(String(rule).toLowerCase()));
  }

  function countControls(profileId) {
    const controlsDir = join(PROFILES_DIR, profileId, "controls");
    if (!existsSync(controlsDir)) return 0;

    let total = 0;
    for (const file of readdirSync(controlsDir)) {
      if (!file.endsWith(".yaml")) continue;
      const controls = parseYaml(readFileSync(join(controlsDir, file), "utf8")) ?? [];
      if (Array.isArray(controls)) total += controls.length;
    }
    return total;
  }

  const profileId = "lvfr-a330-200";
  const titlesToTest = [
    "LVFR A330-200",
    "Airbus A330-200",
    "LatinVFR Airbus A330-200",
    "LVFR A330-300",
    "PMDG 737-900",
  ];

  const profile = loadProfile(profileId);
  const totalControls = countControls(profileId);

  console.log("Perfil:", profile.manifest.aircraft.name);
  console.log("ID:", profile.manifest.aircraft.id);
  console.log("Version minima:", profile.manifest.versions.minimum);
  console.log("Version probada:", profile.manifest.versions.tested.join(", "));
  console.log("Variantes:", profile.manifest.variants.join(" | "));
  console.log("Controles declarados:", totalControls);
  console.log("Detection rules:", profile.detection.titleContains);
  console.log("");

  for (const title of titlesToTest) {
    console.log(
      `[${profileMatchesTitle(profile, title) ? "MATCH" : "NO MATCH"}] ${title}`
    );
  }

  Ejecuta así:

  cd C:\Users\darwi\Downloads\shared-cockpit-backup
  node .\tools\test-lvfr-a330-200.mjs

  Si quieres probar que además salga en la API real del proyecto, usa este otro:

  const res = await fetch("http://localhost:8787/api/aircraft-profiles");
  const profiles = await res.json();
  const a330 = profiles.find((p) => p.id === "lvfr-a330-200");
  console.log(JSON.stringify(a330, null, 2));