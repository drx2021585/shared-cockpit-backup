#!/usr/bin/env node
/**
 * Sonda del bridge local: se conecta a ws://localhost:7620, imprime lo que el
 * bridge emite (bridge.status / control.event / bridge.error) y opcionalmente
 * inyecta un control.event como si viniera del otro piloto.
 *
 * Sirve para probar un perfil contra MSFS **sin necesitar un segundo jugador ni
 * una sesión de red**: el bridge marca todo lo que entra por este WebSocket como
 * origin=remote y lo escribe al sim, que es exactamente el camino que recorre un
 * cambio del copiloto (ver Protocol/IncomingMessageParser.cs).
 *
 * Uso:
 *   node tools/bridge-probe.mjs
 *       Escucha y muestra todo.
 *
 *   node tools/bridge-probe.mjs --filter fuel
 *       Solo eventos cuyo controlId contenga "fuel".
 *
 *   node tools/bridge-probe.mjs --send fuel.fuel_crossfeed_sw=1
 *       Escribe ese control una vez (como si lo hubiera movido el otro piloto).
 *
 *   node tools/bridge-probe.mjs --send gear.autobrake_sw=20 --repeat 6 --interval 500
 *       Manda el mismo destino 6 veces. Es LA prueba para el iFly: cada escritura
 *       avanza un solo paso, asi que hay que ver el valor caminar hacia el
 *       destino. Si se aleja, la polaridad de ese control esta invertida.
 *
 *   node tools/bridge-probe.mjs --send x.y=true --token ABC
 *       Cuando el bridge fue lanzado por We Connect (exige SHAREDCOCKPIT_BRIDGE_TOKEN).
 *
 * Herramienta de diagnostico manual: no corre en CI ni la usa la app.
 */

const args = process.argv.slice(2);

function flag(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const filter = flag("filter");
const send = flag("send");
const token = flag("token");
const repeat = Number(flag("repeat", "1"));
const interval = Number(flag("interval", "500"));
const port = Number(flag("port", "7620"));

if (args.includes("--help") || args.includes("-h")) {
  console.log(new URL(import.meta.url).pathname);
  console.log(
    "\nUso: node tools/bridge-probe.mjs [--filter <txt>] [--send <controlId>=<valor>]" +
      "\n                                 [--repeat N] [--interval ms] [--token T] [--port P]\n",
  );
  process.exit(0);
}

const url = `ws://localhost:${port}/${token ? `?token=${encodeURIComponent(token)}` : ""}`;
console.log(`[probe] conectando a ${url.replace(/token=[^&]*/, "token=***")}`);

const ws = new WebSocket(url);

/** Convierte "1" -> 1, "true" -> true, "abc" -> "abc". */
function parseValue(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  const n = Number(raw);
  return Number.isNaN(n) ? raw : n;
}

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

let sequence = 0;
let opened = false;

function sendControlEvent(controlId, value) {
  const msg = {
    type: "control.event",
    sessionId: "probe",
    controlId,
    value,
    source: "probe",
    sequence: ++sequence,
    timestamp: Date.now(),
  };
  ws.send(JSON.stringify(msg));
  console.log(`${stamp()} --> ESCRIBO   ${controlId} = ${JSON.stringify(value)}  (intento ${sequence}/${repeat})`);
}

ws.addEventListener("open", () => {
  opened = true;
  console.log(`${stamp()} [probe] conectado. Ctrl+C para salir.`);

  if (!send) return;

  const eq = send.indexOf("=");
  if (eq < 0) {
    console.error('[probe] --send espera el formato "controlId=valor", ej. fuel.fuel_crossfeed_sw=1');
    process.exit(2);
  }
  const controlId = send.slice(0, eq);
  const value = parseValue(send.slice(eq + 1));

  let sent = 0;
  const tick = () => {
    sendControlEvent(controlId, value);
    if (++sent < repeat) setTimeout(tick, interval);
  };
  // Pequeña espera para que el primer bridge.status llegue antes de escribir.
  setTimeout(tick, 300);
});

ws.addEventListener("message", (ev) => {
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    console.log(`${stamp()} [raw] ${ev.data}`);
    return;
  }

  switch (msg.type) {
    case "bridge.status":
      console.log(
        `${stamp()} [status] sim=${msg.simConnected ? "CONECTADO" : "desconectado"} ` +
          `perfil=${msg.matchedProfileId ?? "(ninguno)"} titulo=${JSON.stringify(msg.detectedTitle ?? null)} ` +
          `${msg.error ? `error="${msg.error}"` : ""}`,
      );
      return;

    case "bridge.error":
      console.log(`${stamp()} [ERROR]  ${msg.controlId} (${msg.operation}): ${msg.message}`);
      return;

    case "control.event":
    case "control.axis":
      if (filter && !String(msg.controlId).includes(filter)) return;
      console.log(
        `${stamp()} <-- LEO      ${msg.controlId} = ${JSON.stringify(msg.value)}` +
          `${msg.type === "control.axis" ? "  (eje)" : ""}`,
      );
      return;

    default:
      if (filter) return;
      console.log(`${stamp()} [${msg.type}] ${ev.data}`);
  }
});

ws.addEventListener("error", () => {
  // Distinguir "nunca conectó" de "se cayó a mitad": el consejo del token solo
  // aplica al primer caso, y darlo tras una sesión buena confunde.
  if (opened) {
    console.error(`${stamp()} [probe] se perdió la conexión con el bridge.`);
    return;
  }
  console.error(
    `${stamp()} [probe] no se pudo conectar a ws://localhost:${port}. ` +
      "¿Está corriendo SharedCockpit.Bridge.exe? Si lo lanzó We Connect, exige token: " +
      "cerrá We Connect y lanzá el bridge a mano (sin SHAREDCOCKPIT_BRIDGE_TOKEN acepta clientes locales sin token).",
  );
});

ws.addEventListener("close", () => {
  console.log(`${stamp()} [probe] conexión cerrada.`);
  process.exit(0);
});
