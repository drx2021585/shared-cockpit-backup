type FlightMessage = Record<string, any>;

interface SessionStateSnapshot {
  aircraftSnapshot: FlightMessage | null;
  flightPose: FlightMessage | null;
  authorityTransfer: FlightMessage | null;
  controlEvents: Map<string, FlightMessage>;
  controlAxes: Map<string, FlightMessage>;
  screenSnapshots: Map<string, FlightMessage>;
}

function createEmptySessionState(): SessionStateSnapshot {
  return {
    aircraftSnapshot: null,
    flightPose: null,
    authorityTransfer: null,
    controlEvents: new Map(),
    controlAxes: new Map(),
    screenSnapshots: new Map(),
  };
}

export class SessionStateCache {
  private readonly sessions = new Map<string, SessionStateSnapshot>();

  private ensure(joinCode: string): SessionStateSnapshot {
    let state = this.sessions.get(joinCode);
    if (!state) {
      state = createEmptySessionState();
      this.sessions.set(joinCode, state);
    }
    return state;
  }

  remember(joinCode: string, msg: FlightMessage) {
    const state = this.ensure(joinCode);
    switch (msg.type) {
      case "aircraft.snapshot":
        state.aircraftSnapshot = msg;
        break;
      case "flight.pose":
        state.flightPose = msg;
        break;
      case "authority.transfer":
        state.authorityTransfer = msg;
        break;
      case "control.event":
        if (typeof msg.controlId === "string") {
          state.controlEvents.set(msg.controlId, msg);
        }
        break;
      case "control.axis":
        if (typeof msg.controlId === "string") {
          state.controlAxes.set(msg.controlId, msg);
        }
        break;
      case "screen.snapshot":
        if (typeof msg.screenId === "string") {
          state.screenSnapshots.set(msg.screenId, msg);
        }
        break;
    }
  }

  replay(joinCode: string): FlightMessage[] {
    const state = this.sessions.get(joinCode);
    if (!state) return [];

    return [
      ...(state.aircraftSnapshot ? [state.aircraftSnapshot] : []),
      ...(state.authorityTransfer ? [state.authorityTransfer] : []),
      ...Array.from(state.controlEvents.values()),
      ...Array.from(state.controlAxes.values()),
      ...Array.from(state.screenSnapshots.values()),
      ...(state.flightPose ? [state.flightPose] : []),
    ];
  }

  clear(joinCode: string) {
    this.sessions.delete(joinCode);
  }
}
