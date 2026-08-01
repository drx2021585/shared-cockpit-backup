/**
 * El renderer llama ensureHost() desde varios lados a la vez (dos useEffect de
 * App.tsx, apiClient en cada request, Party/Profile). Sin candado, cada llamada
 * entraba con server === null y hacía listen() en paralelo sobre el mismo
 * puerto: EADDRINUSE y "A JavaScript error occurred in the main process".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import directRelay from "../../apps/desktop-ui/electron/directRelay.cjs";

const PORT = 8891;

function makeRelay(port: number) {
  return directRelay.createDirectRelay({
    appVersion: "9.9.9",
    profilesDir: new URL("../../aircraft-profiles", import.meta.url).pathname.slice(1),
    port,
  });
}

test("ensureRunning concurrente levanta un solo listener y no revienta", async () => {
  const relay = makeRelay(PORT);

  try {
    const results = await Promise.all(Array.from({ length: 5 }, () => relay.ensureRunning()));

    // Mismo objeto en las 5 = un solo arranque compartido. Si cada llamada
    // arrancara el suyo, la segunda moriria con EADDRINUSE.
    for (const result of results) {
      assert.equal(result, results[0]);
      assert.equal(result.baseUrl, `http://127.0.0.1:${PORT}`);
    }
    assert.equal(results[0].started, true);

    const health = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).mode, "direct-host");

    // El WebSocketServer se engancha despues del listen: esto falla si ese
    // orden se rompe y /ws deja de existir. 4002 = version de cliente vieja,
    // que es respuesta del relay, o sea que el upgrade llego.
    const closeCode = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?code=X&token=y&clientVersion=0.0.0`);
      ws.addEventListener("close", (event) => resolve(event.code));
      ws.addEventListener("error", () => resolve(-1));
    });
    assert.equal(closeCode, 4002);
  } finally {
    await relay.stop();
  }
});

test("si el puerto preferido esta ocupado por otro programa, usa el siguiente", async () => {
  const squatter = createServer((_req, res) => res.end("no soy el relay"));
  await new Promise<void>((resolve) => squatter.listen(PORT, "0.0.0.0", resolve));

  const relay = makeRelay(PORT);
  try {
    const started = await relay.ensureRunning();

    assert.equal(started.started, true);
    assert.equal(started.baseUrl, `http://127.0.0.1:${PORT + 1}`, "debe caer al siguiente puerto libre");

    // El puerto ocupado sigue siendo del otro programa, no lo pisamos.
    const health = await fetch(`${started.baseUrl}/api/health`);
    assert.equal((await health.json()).mode, "direct-host");
    assert.equal(await (await fetch(`http://127.0.0.1:${PORT}/`)).text(), "no soy el relay");
  } finally {
    await relay.stop();
    // close() solo espera a que mueran los keep-alive de fetch; sin esto cuelga.
    squatter.closeAllConnections();
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  }
});

test("el invitado no necesita la misma version que el anfitrion, solo pasar el piso", async () => {
  // appVersion del anfitrion muy por delante: antes esto rechazaba a cualquier
  // invitado que no corriera exactamente esa version o mas.
  const relay = makeRelay(PORT);
  try {
    const { baseUrl } = await relay.ensureRunning();
    const floor = (await (await fetch(`${baseUrl}/api/health`)).json()).minClientVersion;

    const ask = (clientVersion: string) =>
      fetch(`${baseUrl}/api/aircraft-profiles`, {
        headers: { "X-WeConnect-Client-Version": clientVersion },
      }).then((res) => res.status);

    assert.equal(await ask(floor), 200, "un invitado justo en el piso entra");
    assert.equal(await ask("0.1.47"), 426, "por debajo del piso se pide actualizar");
  } finally {
    await relay.stop();
  }
});

test("sin puerto explicito el host usa 25071, el mismo que YourControls", async () => {
  const relay = directRelay.createDirectRelay({
    appVersion: "9.9.9",
    profilesDir: new URL("../../aircraft-profiles", import.meta.url).pathname.slice(1),
  });
  try {
    const { baseUrl } = await relay.ensureRunning();
    assert.equal(baseUrl, "http://127.0.0.1:25071", "los dos jugadores tienen que coincidir en este numero");
  } finally {
    await relay.stop();
  }
});
