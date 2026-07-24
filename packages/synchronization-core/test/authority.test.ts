import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthorityManager } from "../src/authority.ts";

test("shared authority: both seats can write", () => {
  const mgr = new AuthorityManager();
  mgr.registerGroup({ groupId: "lights", authority: "shared" });
  assert.equal(mgr.canWrite("lights", "captain"), true);
  assert.equal(mgr.canWrite("lights", "first_officer"), true);
});

test("exclusive authority: only current owner can write", () => {
  const mgr = new AuthorityManager();
  mgr.registerGroup({ groupId: "flight_controls", authority: "exclusive" }, "captain");
  assert.equal(mgr.canWrite("flight_controls", "captain"), true);
  assert.equal(mgr.canWrite("flight_controls", "first_officer"), false);
});

test("transfer moves ownership and bumps revision", () => {
  const mgr = new AuthorityManager();
  mgr.registerGroup({ groupId: "flight_controls", authority: "exclusive" }, "captain");

  const result = mgr.transfer("flight_controls", "captain", "first_officer");
  assert.equal(result.ok, true);
  assert.equal(result.revision, 1);
  assert.equal(mgr.canWrite("flight_controls", "first_officer"), true);
  assert.equal(mgr.canWrite("flight_controls", "captain"), false);
});

test("transfer fails if requester is not the current owner", () => {
  const mgr = new AuthorityManager();
  mgr.registerGroup({ groupId: "flight_controls", authority: "exclusive" }, "captain");

  const result = mgr.transfer("flight_controls", "first_officer", "captain");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-current-owner");
  // el dueño no debe haber cambiado
  assert.equal(mgr.getOwner("flight_controls"), "captain");
});

test("shared group cannot be transferred (not exclusive)", () => {
  const mgr = new AuthorityManager();
  mgr.registerGroup({ groupId: "radios", authority: "shared" });
  const result = mgr.transfer("radios", "captain", "first_officer");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "group-not-transferable");
});

test("captain-only authority blocks first officer writes", () => {
  const mgr = new AuthorityManager();
  mgr.registerGroup({ groupId: "autopilot", authority: "captain-only" });
  assert.equal(mgr.canWrite("autopilot", "captain"), true);
  assert.equal(mgr.canWrite("autopilot", "first_officer"), false);
});
