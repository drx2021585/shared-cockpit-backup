import test from "node:test";
import assert from "node:assert/strict";
import { parseHostIpv4 } from "../src/lib/relayConfig.ts";

test("parseHostIpv4 acepta lo que el usuario teclea de verdad", () => {
  assert.equal(parseHostIpv4("192.168.1.50"), "192.168.1.50");
  assert.equal(parseHostIpv4(" 192.168.1.50 "), "192.168.1.50");
  assert.equal(parseHostIpv4("192.168.1.50:25071"), "192.168.1.50");
  assert.equal(parseHostIpv4("http://192.168.1.50:25071/"), "192.168.1.50");
  assert.equal(parseHostIpv4("10.0.0.7"), "10.0.0.7");
});

test("parseHostIpv4 rechaza lo que no es IPv4", () => {
  assert.equal(parseHostIpv4(""), null);
  assert.equal(parseHostIpv4("mi-pc.local"), null);
  assert.equal(parseHostIpv4("192.168.1"), null);
  assert.equal(parseHostIpv4("192.168.1.999"), null);
});
