import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMirrorBootstrapMessages,
  buildParticipantFingerprint,
} from "../../apps/desktop-ui/src/lib/sessionMirror.ts";

test("buildParticipantFingerprint es estable aunque cambie el orden de llegada en el array", () => {
  const a = buildParticipantFingerprint([
    { pilot_name: "Bob", seat: "first_officer", joined_at: "2026-07-31T10:00:01Z" },
    { pilot_name: "Alice", seat: "captain", joined_at: "2026-07-31T10:00:00Z" },
  ]);
  const b = buildParticipantFingerprint([
    { pilot_name: "Alice", seat: "captain", joined_at: "2026-07-31T10:00:00Z" },
    { pilot_name: "Bob", seat: "first_officer", joined_at: "2026-07-31T10:00:01Z" },
  ]);

  assert.equal(a, b);
});

test("buildMirrorBootstrapMessages reemite el estado completo visible por un peer nuevo", () => {
  const messages = buildMirrorBootstrapMessages({
    joinCode: "ABC-123",
    pilotName: "Alice",
    controls: {
      "lights.beacon": {
        controlId: "lights.beacon",
        value: true,
        channel: "event",
        updatedAt: 1000,
      },
      "flight.yoke.pitch": {
        controlId: "flight.yoke.pitch",
        value: 0.35,
        channel: "axis",
        updatedAt: 1010,
      },
    },
    screens: {
      cdu_captain: {
        screenId: "cdu_captain",
        rows: 2,
        cols: 2,
        cells: [
          { char: "A", colorId: 0, flags: 0 },
          { char: "B", colorId: 1, flags: 0 },
          { char: "C", colorId: 2, flags: 0 },
          { char: "D", colorId: 3, flags: 0 },
        ],
        powered: true,
        revision: 7,
        updatedAt: 1020,
      },
    },
    pose: {
      type: "flight.pose",
      sessionId: "local",
      sequence: 88,
      timestamp: 999,
      lat: 1,
      lon: 2,
      alt: 3,
      pitch: 4,
      bank: 5,
      heading: 6,
      groundSpeed: 7,
      indicatedAirspeed: 8,
      verticalSpeed: 9,
      updatedAt: 1030,
    },
    includePose: true,
  });

  assert.equal(messages.length, 4);
  assert.deepEqual(messages[0], {
    type: "control.event",
    sessionId: "ABC-123",
    controlId: "lights.beacon",
    value: true,
    source: "Alice",
    sequence: 1000,
    timestamp: 1000,
  });
  assert.deepEqual(messages[1], {
    type: "control.axis",
    sessionId: "ABC-123",
    controlId: "flight.yoke.pitch",
    value: 0.35,
    source: "Alice",
    sequence: 1010,
    timestamp: 1010,
  });
  assert.deepEqual(messages[2], {
    type: "screen.snapshot",
    sessionId: "ABC-123",
    screenId: "cdu_captain",
    rows: 2,
    cols: 2,
    cells: [
      { char: "A", colorId: 0, flags: 0 },
      { char: "B", colorId: 1, flags: 0 },
      { char: "C", colorId: 2, flags: 0 },
      { char: "D", colorId: 3, flags: 0 },
    ],
    powered: true,
    revision: 7,
    timestamp: 1020,
  });
  assert.deepEqual(messages[3], {
    type: "flight.pose",
    sessionId: "ABC-123",
    sequence: 88,
    timestamp: 1030,
    lat: 1,
    lon: 2,
    alt: 3,
    pitch: 4,
    bank: 5,
    heading: 6,
    groundSpeed: 7,
    indicatedAirspeed: 8,
    verticalSpeed: 9,
    updatedAt: 1030,
  });
});

test("buildMirrorBootstrapMessages omite flight.pose si este cliente no tiene autoridad de vuelo", () => {
  const messages = buildMirrorBootstrapMessages({
    joinCode: "ABC-123",
    pilotName: "Bob",
    controls: {},
    screens: {},
    pose: {
      type: "flight.pose",
      sessionId: "local",
      sequence: 1,
      timestamp: 1,
      lat: 0,
      lon: 0,
      alt: 0,
      pitch: 0,
      bank: 0,
      heading: 0,
      groundSpeed: 0,
      indicatedAirspeed: 0,
      verticalSpeed: 0,
      updatedAt: 2,
    },
    includePose: false,
  });

  assert.deepEqual(messages, []);
});
