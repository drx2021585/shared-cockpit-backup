import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDrift } from "../src/drift.ts";

test("detectDrift finds no divergence when snapshots match", () => {
  const snapshot = { electrical: { master_battery: true }, lights: { beacon: false } };
  const diffs = detectDrift(snapshot, snapshot);
  assert.deepEqual(diffs, []);
});

test("detectDrift reports exact system+key that diverged", () => {
  const local = { electrical: { master_battery: true }, lights: { beacon: false } };
  const remote = { electrical: { master_battery: true }, lights: { beacon: true } };
  const diffs = detectDrift(local, remote);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].system, "lights");
  assert.equal(diffs[0].key, "beacon");
  assert.equal(diffs[0].localValue, false);
  assert.equal(diffs[0].remoteValue, true);
});

test("detectDrift handles a system missing entirely on one side", () => {
  const local = {};
  const remote = { fuel: { selector: 2 } };
  const diffs = detectDrift(local, remote);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].system, "fuel");
  assert.equal(diffs[0].localValue, undefined);
});

test("detectDrift also catches a system that exists only locally (asymmetric case)", () => {
  // Escenario real para una aeronave con muchos sistemas (ej. PMDG 737): un
  // cliente ya reporta hydraulic.sys_a_pressure y el otro todavía no. Antes
  // esto se ignoraba silenciosamente porque solo se iteraba Object.keys(remote).
  const local = { hydraulic: { sys_a_pressure: 3000 } };
  const remote = {};
  const diffs = detectDrift(local, remote);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].system, "hydraulic");
  assert.equal(diffs[0].key, "sys_a_pressure");
  assert.equal(diffs[0].localValue, 3000);
  assert.equal(diffs[0].remoteValue, undefined);
});

test("detectDrift also catches a key that exists only locally within a shared system", () => {
  const local = { electrical: { battery: true, apu_generator: true } };
  const remote = { electrical: { battery: true } };
  const diffs = detectDrift(local, remote);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].system, "electrical");
  assert.equal(diffs[0].key, "apu_generator");
  assert.equal(diffs[0].localValue, true);
  assert.equal(diffs[0].remoteValue, undefined);
});
