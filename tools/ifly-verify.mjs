#!/usr/bin/env node
/**
 * Verificacion en vivo del perfil ifly-737-max8 contra MSFS.
 *
 *   node tools/ifly-verify.mjs
 *
 * Corre una bateria de comprobaciones contra el bridge local y el simulador
 * REAL, y devuelve un resumen con PASA / FALLA por cada una. Sirve como test de
 * aceptacion: despues de tocar el perfil, el generador o el bridge, esto dice en
 * ~30 segundos si algo se rompio, sin tener que acordarse de diez comandos
 * sueltos de tools/bridge-probe.mjs.
 *
 * REQUISITOS: MSFS abierto con el iFly 737 MAX 8 cargado, FSUIPC7 corriendo, el
 * bridge escuchando en 7620, y el AVION EN TIERRA Y FRENADO -- esto mueve
 * superficies de vuelo y enciende/apaga el APU de verdad.
 *
 * Cada comprobacion escribe un valor, escucha lo que el avion reporta de vuelta,
 * y clasifica el resultado:
 *
 *   PASA          el control llego al valor pedido
 *   INVERTIDO     el bridge detecto que se alejaba del destino (polaridad
 *                 invertida en el perfil, ver ObserveConfirmedValue)
 *   SIN EFECTO    no llego ninguna lectura: la escritura no movio nada
 *   NO CONVERGE   se movio pero no llego a tiempo
 *   ERROR         el bridge reporto un bridge.error
 *
 * Al terminar restaura los controles a un estado seguro (APU apagado,
 * superficies centradas).
 *
 * Opciones:
 *   --port P       puerto del bridge (default 7620)
 *   --token T      si el bridge lo lanzo We Connect
 *   --skip-axes    no tocar superficies de vuelo
 *   --rudder       incluir el rudder (por defecto se OMITE: si hay pedales o un
 *                  joystick con eje de rudder asignado, el hardware reaplica su
 *                  posicion ~60 veces por segundo y pisa cualquier escritura, asi
 *                  que el resultado no dice nada del perfil -- medido en vivo el
 *                  2026-07-29)
 */

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const has = (n) => args.includes(`--${n}`);

const port = Number(flag("port", "7620"));
const token = flag("token");

if (has("help") || has("h")) {
  console.log(import.meta.url);
  process.exit(0);
}

/**
 * Cada paso: escribe `value` en `id` y espera hasta `waitMs` a que el avion
 * reporte ese valor. `tolerance` porque los ejes son continuos y las L-Vars de
 * iFly estan ANIMADAS (interpolan: se midio 14.75 entre 20 y 10), asi que exigir
 * igualdad exacta daria falsos negativos.
 */
/**
 * `prime` lleva el control al lado opuesto ANTES de medir, y su resultado se
 * descarta. Sin eso, un control que ya estaba en el valor pedido no genera
 * ninguna lectura (el bridge solo emite cuando algo CAMBIA) y el paso se
 * clasificaria como "SIN EFECTO" siendo que en realidad ya estaba bien -- falso
 * negativo real, visto en la primera corrida de este script con el APU ya
 * encendido.
 */
const CHECKS = [
  {
    group: "APU (maquina de estados 0=OFF / 10=ON / 20=START)",
    steps: [
      { id: "engine.apu_sw", prime: 0, value: 10, tolerance: 1, waitMs: 5000, label: "encender (OFF -> ON)" },
      { id: "engine.apu_sw", prime: 10, value: 0, tolerance: 1, waitMs: 5000, label: "apagar (ON -> OFF)" },
    ],
  },
  {
    group: "Selector multi-posicion (prueba el lazo de convergencia)",
    steps: [
      { id: "gear.autobrake_sw", prime: 0, value: 20, tolerance: 1, waitMs: 8000, label: "autobrake 0 -> 20 (2 pasos)" },
      { id: "gear.autobrake_sw", prime: 50, value: 0, tolerance: 1, waitMs: 9000, label: "autobrake 50 -> 0 (5 pasos)" },
    ],
  },
  {
    group: "Ejes de superficies (canal rapido)",
    axes: true,
    steps: [
      { id: "flight.yoke.pitch", stream: true, prime: 0, value: 0.3, tolerance: 0.05, waitMs: 3000, label: "elevador -> 0.3" },
      { id: "flight.yoke.pitch", stream: true, prime: 0.3, value: 0, tolerance: 0.05, waitMs: 3000, label: "elevador -> centro" },
      { id: "flight.yoke.roll", stream: true, prime: 0, value: 0.4, tolerance: 0.05, waitMs: 3000, label: "aleron -> 0.4" },
      { id: "flight.yoke.roll", stream: true, prime: 0.4, value: 0, tolerance: 0.05, waitMs: 3000, label: "aleron -> centro" },
    ],
  },
  {
    group: "Rudder (omitido por defecto, ver --rudder)",
    rudder: true,
    steps: [
      { id: "flight.rudder", stream: true, prime: 0, value: 0.4, tolerance: 0.05, waitMs: 3000, label: "rudder -> 0.4" },
      { id: "flight.rudder", stream: true, prime: 0.4, value: 0, tolerance: 0.05, waitMs: 3000, label: "rudder -> centro" },
    ],
  },
];

const url = `ws://localhost:${port}/${token ? `?token=${encodeURIComponent(token)}` : ""}`;
const ws = new WebSocket(url);

let sequence = 0;
const results = [];

/** Estado del paso en curso: lecturas y errores que llegan mientras corre. */
let current = null;

ws.addEventListener("message", (ev) => {
  let m;
  try {
    m = JSON.parse(ev.data);
  } catch {
    return;
  }

  if (m.type === "bridge.status") {
    current?.onStatus?.(m);
    return;
  }
  if (!current) return;

  if (m.type === "bridge.error" && m.controlId === current.step.id) {
    current.errors.push(m.message ?? "");
    return;
  }
  if ((m.type === "control.event" || m.type === "control.axis") && m.controlId === current.step.id) {
    current.readings.push(Number(m.value));
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(id, value) {
  ws.send(
    JSON.stringify({
      type: "control.event",
      sessionId: "verify",
      controlId: id,
      value,
      source: "verify",
      sequence: ++sequence,
      timestamp: Date.now(),
    }),
  );
}

async function runStep(step) {
  // Llevarlo al lado opuesto primero, para que el paso medido SIEMPRE implique
  // un cambio observable (ver comentario de CHECKS).
  if (step.prime !== undefined) {
    current = { step: { id: step.id }, readings: [], errors: [] };
    send(step.id, step.prime);
    await sleep(Math.min(step.waitMs, 5000));
    current = null;
  }

  current = { step, readings: [], errors: [] };
  send(step.id, step.value);

  // Los ejes van por el CANAL RAPIDO: en uso real el otro piloto los transmite
  // continuamente a 20-60 Hz, no de a un disparo suelto. Mandar uno solo no es
  // representativo y ademas da un resultado enganoso: medido el 2026-07-29, un
  // 0 seguido de un 0.3 aislado dejaba la superficie en 0.15 -- exactamente la
  // mitad -- porque MSFS promedia las entradas de eje recientes. Transmitido de
  // forma continua, como en un vuelo real, llega al valor pedido.
  let streamTimer = null;
  if (step.stream) {
    streamTimer = setInterval(() => send(step.id, step.value), 50);
  }

  const deadline = Date.now() + step.waitMs;
  while (Date.now() < deadline) {
    await sleep(100);
    const hit = current.readings.some((v) => Math.abs(v - step.value) <= step.tolerance);
    if (hit) break;
    if (current.errors.length) break;
  }

  if (streamTimer) clearInterval(streamTimer);

  const { readings, errors } = current;
  current = null;

  const reached = readings.some((v) => Math.abs(v - step.value) <= step.tolerance);
  const last = readings.length ? readings[readings.length - 1] : null;

  let verdict;
  if (reached) verdict = "PASA";
  else if (errors.some((e) => e.includes("polaridad"))) verdict = "INVERTIDO";
  else if (errors.some((e) => e.includes("no declarado"))) verdict = "NO EXISTE";
  else if (errors.length) verdict = "ERROR";
  else if (readings.length === 0) verdict = "SIN EFECTO";
  else verdict = "NO CONVERGE";

  return { ...step, verdict, last, readings: readings.length, detail: errors[0] ?? "" };
}

ws.addEventListener("open", async () => {
  console.log(`[verify] conectado a ${url.replace(/token=[^&]*/, "token=***")}`);

  // Esperar el bridge.status inicial para confirmar perfil y sim.
  const status = await new Promise((resolve) => {
    current = { step: { id: "__none__" }, readings: [], errors: [], onStatus: resolve };
    setTimeout(() => resolve(null), 3000);
  });
  current = null;

  if (!status?.simConnected) {
    console.error("[verify] MSFS no esta conectado al bridge. Abortado.");
    process.exit(1);
  }
  if (status.matchedProfileId !== "ifly-737-max8") {
    console.error(
      `[verify] el perfil activo es '${status.matchedProfileId ?? "(ninguno)"}' con titulo ` +
        `${JSON.stringify(status.detectedTitle)}. Cargue el iFly 737 MAX 8. Abortado.`,
    );
    process.exit(1);
  }
  console.log(`[verify] perfil 'ifly-737-max8' detectado, titulo ${JSON.stringify(status.detectedTitle)}`);
  console.log("[verify] ATENCION: esto mueve superficies y el APU de verdad. Avion en tierra y frenado.\n");

  for (const group of CHECKS) {
    if (group.axes && has("skip-axes")) continue;
    if (group.rudder && !has("rudder")) continue;

    console.log(`--- ${group.group}`);
    for (const step of group.steps) {
      const r = await runStep(step);
      results.push({ group: group.group, ...r });
      const value = r.last === null ? "sin lecturas" : `ultimo=${r.last}`;
      console.log(`    [${r.verdict.padEnd(11)}] ${step.label}  (${value}, ${r.readings} lecturas)`);
      if (r.detail) console.log(`                  ${r.detail}`);
    }
  }

  const failed = results.filter((r) => r.verdict !== "PASA");
  console.log(`\n=== ${results.length - failed.length}/${results.length} comprobaciones PASAN`);
  if (failed.length) {
    console.log("Fallaron:");
    for (const f of failed) console.log(`  ${f.verdict.padEnd(11)} ${f.id}  ->  ${f.value}`);
  }
  ws.close();
  process.exit(failed.length ? 1 : 0);
});

ws.addEventListener("error", () => {
  console.error(
    `[verify] no se pudo conectar a ws://localhost:${port}: el bridge no esta corriendo.\n` +
      '  Arrancalo con: Start-Process "<repo>\\apps\\simulator-bridge\\src\\SimulatorBridge\\publish\\SharedCockpit.Bridge.exe"',
  );
  process.exit(1);
});
