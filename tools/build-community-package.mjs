#!/usr/bin/env node
/**
 * Genera manifest.json y layout.json del paquete de Community desde los archivos
 * REALES que hay en PackageSources/.
 *
 * Por qué existe: los dos archivos se mantenían a mano y los dos estaban mal.
 * manifest.json declaraba `total_package_size: "00000000000000000000"` (el
 * placeholder de la plantilla del SDK) y layout.json declaraba `date: 0` para el
 * .wasm. MSFS lee ambos para decidir qué cargar y para detectar paquetes
 * corruptos; un layout que no coincide con los archivos en disco es justo la
 * clase de cosa que hace que el paquete se ignore en silencio.
 *
 * Mantenerlos a mano además garantiza que se desincronicen: cada vez que se
 * recompile el .wasm cambia su tamaño, y nadie se va a acordar de actualizar los
 * dos JSON.
 *
 * Uso:
 *   node tools/build-community-package.mjs [--check]
 *
 *   sin flags   reescribe manifest.json y layout.json
 *   --check     no escribe; falla con exit 1 si están desactualizados (para CI)
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const PACKAGE_DIR = path.join("simulator", "wasm-bridge", "PackageSources");
const MANIFEST = path.join(PACKAGE_DIR, "manifest.json");
const LAYOUT = path.join(PACKAGE_DIR, "layout.json");

/** Los dos JSON se describen a sí mismos, así que nunca van en el contenido. */
const SELF_DESCRIBING = new Set(["manifest.json", "layout.json"]);

/**
 * MSFS espera fechas en FILETIME de Windows: intervalos de 100 ns desde
 * 1601-01-01. Es el mismo formato que usan los layout.json de los paquetes
 * reales (verificado contra un addon de terceros instalado).
 */
const FILETIME_EPOCH_OFFSET_MS = 11644473600000n;
const toFileTime = (mtimeMs) =>
  (BigInt(Math.floor(mtimeMs)) + FILETIME_EPOCH_OFFSET_MS) * 10000n;

function collectFiles(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const abs = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...collectFiles(abs, rel));
    } else if (!SELF_DESCRIBING.has(rel)) {
      const st = statSync(abs);
      out.push({ path: rel, size: st.size, date: Number(toFileTime(st.mtimeMs)) });
    }
  }
  return out;
}

const content = collectFiles(PACKAGE_DIR);
if (content.length === 0) {
  console.error(`ERROR: no hay archivos de contenido en ${PACKAGE_DIR}`);
  process.exit(1);
}

const totalBytes = content.reduce((sum, f) => sum + f.size, 0);

// El manifest existente es la fuente de los campos editoriales (título, creador,
// versión, versión mínima del sim): este script solo corrige lo que se deriva de
// los archivos, no reescribe decisiones.
const existing = JSON.parse(readFileSync(MANIFEST, "utf8"));
const manifest = {
  ...existing,
  // MSFS lo espera como cadena; los paquetes reales lo traen sin ceros a la
  // izquierda.
  total_package_size: String(totalBytes),
};

const layout = { content };

const nextManifest = `${JSON.stringify(manifest, null, 2)}\n`;
const nextLayout = `${JSON.stringify(layout, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const stale = [];
  if (readFileSync(MANIFEST, "utf8") !== nextManifest) stale.push("manifest.json");
  if (readFileSync(LAYOUT, "utf8") !== nextLayout) stale.push("layout.json");
  if (stale.length > 0) {
    console.error(
      `ERROR: ${stale.join(" y ")} no coinciden con los archivos de ${PACKAGE_DIR}.\n` +
        "Correr: node tools/build-community-package.mjs"
    );
    process.exit(1);
  }
  console.log(`OK: manifest.json y layout.json al día (${content.length} archivo(s), ${totalBytes} bytes).`);
  process.exit(0);
}

writeFileSync(MANIFEST, nextManifest);
writeFileSync(LAYOUT, nextLayout);

console.log(`Paquete: ${manifest.title} v${manifest.package_version}`);
console.log(`  minimum_game_version: ${manifest.minimum_game_version}`);
for (const f of content) {
  console.log(`  ${f.path.padEnd(40)} ${String(f.size).padStart(9)} bytes`);
}
console.log(`  total_package_size:   ${totalBytes} bytes`);
