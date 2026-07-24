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
