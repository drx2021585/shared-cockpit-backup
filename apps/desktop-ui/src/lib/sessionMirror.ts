import type {
  ControlAxis,
  ControlEvent,
  FlightPose,
  ScreenSnapshot,
} from "../../../../packages/protocol/types";
import type {
  BridgeControlValue,
  BridgeFlightPose,
  BridgeScreenSnapshot,
} from "./bridgeClient";
import type { SessionParticipant } from "./apiClient";

export function buildParticipantFingerprint(participants: SessionParticipant[]): string {
  return participants
    .map((participant) => `${participant.seat}:${participant.pilot_name}:${participant.joined_at}`)
    .sort()
    .join("|");
}

export function buildMirrorBootstrapMessages(args: {
  joinCode: string;
  pilotName: string;
  controls: Record<string, BridgeControlValue>;
  screens: Record<string, BridgeScreenSnapshot>;
  pose: BridgeFlightPose | null;
  includePose: boolean;
}): Array<ControlEvent | ControlAxis | ScreenSnapshot | FlightPose> {
  const messages: Array<ControlEvent | ControlAxis | ScreenSnapshot | FlightPose> = [];

  for (const [controlId, entry] of Object.entries(args.controls)) {
    messages.push({
      type: entry.channel === "event" ? "control.event" : "control.axis",
      sessionId: args.joinCode,
      controlId,
      value: entry.value,
      source: args.pilotName,
      sequence: entry.updatedAt,
      timestamp: entry.updatedAt,
    } as ControlEvent | ControlAxis);
  }

  for (const [screenId, screen] of Object.entries(args.screens)) {
    messages.push({
      type: "screen.snapshot",
      sessionId: args.joinCode,
      screenId,
      rows: screen.rows,
      cols: screen.cols,
      cells: screen.cells,
      powered: screen.powered ?? undefined,
      revision: screen.revision,
      timestamp: screen.updatedAt,
    });
  }

  if (args.includePose && args.pose) {
    messages.push({
      ...args.pose,
      sessionId: args.joinCode,
      timestamp: args.pose.updatedAt,
    });
  }

  return messages;
}
