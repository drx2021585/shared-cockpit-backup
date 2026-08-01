/**
 * El renderer llama ensureHost() desde varios lados a la vez (dos useEffect de
 * App.tsx, apiClient en cada request, Party/Profile). Sin candado, cada llamada
 * entraba con server === null y hacía listen() en paralelo sobre el mismo
 * puerto: EADDRINUSE y "A JavaScript error occurred in the main process".
 */
import test from "node:test";
import assert from "node:assert/strict";
import directRelay from "../../apps/desktop-ui/electron/directRelay.cjs";

const PORT = 8891;

test("ensureRunning concurrente levanta un solo listener y no revienta", async () => {
  const relay = directRelay.createDirectRelay({
    appVersion: "0.0.1",
    profilesDir: new URL("../../aircraft-profiles", import.meta.url).pathname.slice(1),
    port: PORT,
  });

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
  } finally {
    await relay.stop();
  }
});
