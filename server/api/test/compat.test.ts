import test from "node:test";
import assert from "node:assert/strict";
import { buildHealthPayload, compareVersions, isClientVersionSupported } from "../src/compat.ts";

test("compareVersions orders dotted versions correctly", () => {
  assert.equal(compareVersions("0.1.20", "0.1.20"), 0);
  assert.equal(compareVersions("0.1.21", "0.1.20") > 0, true);
  assert.equal(compareVersions("0.1.19", "0.1.20") < 0, true);
});

test("isClientVersionSupported enforces the minimum version", () => {
  assert.equal(isClientVersionSupported("0.1.40"), false);
  assert.equal(isClientVersionSupported("0.1.41"), false);
  assert.equal(isClientVersionSupported("0.1.42"), false);
  assert.equal(isClientVersionSupported("0.1.43"), false);
  assert.equal(isClientVersionSupported("0.1.44"), false);
  assert.equal(isClientVersionSupported("0.1.45"), true);
  assert.equal(isClientVersionSupported("0.1.23"), false);
  assert.equal(isClientVersionSupported("0.1.19"), false);
  assert.equal(isClientVersionSupported(null), false);
});

test("buildHealthPayload exposes client compatibility metadata", () => {
  const payload = buildHealthPayload();
  assert.equal(payload.status, "ok");
  assert.equal(typeof payload.apiVersion, "number");
  assert.equal(typeof payload.minClientVersion, "string");
  assert.equal(typeof payload.latestClientVersion, "string");
});
