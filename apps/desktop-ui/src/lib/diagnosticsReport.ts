import type { BridgeDiagnostics, BridgeErrorEntry, SimulatorBridgeState } from "./bridgeClient";
import { readSessionJournal } from "./sessionJournal";
import { groupErrors, peakErrorsPerSecond } from "./reportAnalysis";
import { currentVersion } from "../data";

/**
 * Arma el reporte de diagnóstico descargable de la vista Cockpit.
 *
 * PARA QUÉ SIRVE
 * --------------
 * Hasta ahora, diagnosticar una sesión que no sincronizaba obligaba a pedirle al
 * usuario que buscara `bridge.log` en %APPDATA% y lo mandara a mano. Ese archivo
 * tiene tres problemas: es ruidoso (mezcla todo el log del proceso), no sabe nada
 * de la sesión (ni el código, ni el asiento, ni qué mandó el otro piloto), y no
 * trae contadores agregados -- que son lo que permite ver de un golpe si un fallo
 * es masivo o puntual.
 *
 * CÓMO ESTÁ ORDENADO
 * ------------------
 * `summary` va primero y es legible por una persona: si algo es obvio (FSUIPC7
 * ausente, cero escrituras confirmadas, una avalancha de errores) se ve ahí sin
 * abrir el resto. Debajo va el detalle completo, pensado para leerse con
 * herramientas.
 *
 * LÍMITE CONOCIDO
 * ---------------
 * Cada jugador genera SU reporte. Que la app le pida el reporte al otro y salga un
 * archivo único con los dos lados alineados requiere un mensaje nuevo en
 * packages/protocol, que es contrato compartido. Mientras tanto, los dos reportes
 * por separado cubren casi todo: el journal de sesión ya registra qué llegó del
 * otro piloto y cuándo, así que se puede correlacionar a mano. Lo único que se
 * pierde es la alineación exacta de relojes.
 */

export interface DiagnosticsReportInput {
  bridge: SimulatorBridgeState;
  fsuipc: WeConnectFsuipcStatus | null;
  session: {
    joinCode: string | null;
    pilotName: string | null;
    role: string | null;
    connected: boolean;
    reconnecting: boolean;
    pingMs: number | null;
    peerAircraft: Record<string, { profileId: string; simulatorVersion: string | null }>;
  };
  communityPath: string | null;
}

/** Señales que se pueden juzgar sin contexto y que explican los fallos más comunes. */
function buildFindings(input: DiagnosticsReportInput, d: BridgeDiagnostics | null): string[] {
  const findings: string[] = [];
  const { bridge, fsuipc, session } = input;

  if (!fsuipc) {
    findings.push("FSUIPC7 status unknown (report generated outside the desktop app).");
  } else if (!fsuipc.installed) {
    findings.push(
      "BLOCKING: FSUIPC7 is not installed. Add-on cockpits (iFly 737 MAX 8, PMDG 737) cannot be read or written at all without it.",
    );
  } else if (!fsuipc.wapiPresent) {
    findings.push(
      "BLOCKING: FSUIPC7 is installed but FSUIPC_WAPID.dll is missing, which is the component that exposes cockpit variables.",
    );
  }

  if (bridge.connectionState !== "connected") {
    findings.push(`Local bridge is "${bridge.connectionState}" — nothing can reach the simulator.`);
  }
  if (!bridge.detectedProfileId) {
    findings.push("No aircraft profile matched: the loaded aircraft is not recognized.");
  }
  if (!session.connected) {
    findings.push("Not connected to the session — the other pilot's changes cannot arrive.");
  }

  if (d) {
    if (d.writesAttempted > 0 && d.writesConfirmed === 0) {
      findings.push(
        `${d.writesAttempted} writes were attempted and NONE was confirmed. Writes are reaching the simulator but nothing moves.`,
      );
    }
    if (d.writesFailed > 0 && d.writesFailed >= d.writesConfirmed) {
      findings.push(
        `More writes failed (${d.writesFailed}) than succeeded (${d.writesConfirmed}) — likely a profile-wide problem, not individual controls.`,
      );
    }
    if (d.polarityInversionsLearned > 0) {
      findings.push(
        `The bridge measured and corrected the polarity of ${d.polarityInversionsLearned} control(s). These should be written into the profile YAML so every player gets them.`,
      );
    }
  }

  const peak = peakErrorsPerSecond(bridge.errors);
  if (peak >= 20) {
    findings.push(
      `Burst of ${peak} errors within one second — that pattern means a mass failure (e.g. the whole cockpit state being re-applied), not isolated controls.`,
    );
  }

  const journal = readSessionJournal();
  if (session.connected && journal.peerControlsTotal === 0) {
    findings.push(
      "Connected to the session but NOTHING was received from the other pilot. Either they are not touching anything, or their bridge is not sending.",
    );
  }

  if (findings.length === 0) {
    findings.push("No blocking problem detected automatically.");
  }
  return findings;
}

export function buildDiagnosticsReport(input: DiagnosticsReportInput) {
  const { bridge, fsuipc, session, communityPath } = input;
  const d = bridge.diagnostics;
  const journal = readSessionJournal();

  const errorsTruncated = d ? d.errorsReported > bridge.errors.length : false;

  return {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    summary: {
      findings: buildFindings(input, d),
      appVersion: currentVersion,
      pilot: session.pilotName,
      joinCode: session.joinCode,
      role: session.role,
      aircraftProfile: bridge.detectedProfileId,
      aircraftTitleFromSim: d?.detectedTitle ?? null,
      simulator: bridge.simulatorVersion,
      bridgeConnection: bridge.connectionState,
      sessionConnected: session.connected,
      pingMs: session.pingMs,
      fsuipc: fsuipc
        ? { installed: fsuipc.installed, wapiPresent: fsuipc.wapiPresent, path: fsuipc.path }
        : null,
      writes: d
        ? {
            attempted: d.writesAttempted,
            skippedAlreadyAtValue: d.writesSkippedAlreadyAtValue,
            confirmed: d.writesConfirmed,
            failed: d.writesFailed,
          }
        : null,
      polarityCorrectionsLearned: d?.polarityInversionsLearned ?? 0,
      errorsTotal: d?.errorsReported ?? bridge.errors.length,
      errorsInThisReport: bridge.errors.length,
      errorsTruncated,
      peakErrorsPerSecond: peakErrorsPerSecond(bridge.errors),
      peerControlsReceived: journal.peerControlsTotal,
    },

    environment: {
      appVersion: currentVersion,
      userAgent: navigator.userAgent,
      communityPath,
      fsuipc,
    },

    bridge: {
      mode: bridge.mode,
      connectionState: bridge.connectionState,
      reconnecting: bridge.reconnecting,
      detectedProfileId: bridge.detectedProfileId,
      simulatorVersion: bridge.simulatorVersion,
      lastMessageAt: bridge.lastMessageAt,
      controlsKnownLocally: Object.keys(bridge.controls).length,
      diagnostics: d,
    },

    /** La lista accionable: qué corregir en el perfil. */
    polarityCorrections: d?.polarityInvertedControls ?? [],

    errors: {
      total: d?.errorsReported ?? bridge.errors.length,
      included: bridge.errors.length,
      truncated: errorsTruncated,
      grouped: groupErrors(bridge.errors),
      recent: bridge.errors.slice(-150),
    },

    session: {
      joinCode: session.joinCode,
      pilotName: session.pilotName,
      role: session.role,
      connected: session.connected,
      reconnecting: session.reconnecting,
      pingMs: session.pingMs,
      peerAircraft: session.peerAircraft,
      startedAt: journal.startedAt,
      events: journal.sessionEvents,
      peerControls: {
        total: journal.peerControlsTotal,
        distinctControls: Object.keys(journal.peerControlCounts).length,
        /** Los 60 controles que más mandó el otro piloto. */
        topControls: Object.entries(journal.peerControlCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 60)
          .map(([controlId, count]) => ({ controlId, count })),
        recent: journal.peerControls.slice(-120),
      },
    },
  };
}

/** Dispara la descarga del reporte como archivo .json. */
export function downloadDiagnosticsReport(input: DiagnosticsReportInput): string {
  const report = buildDiagnosticsReport(input);

  // Nombre con sello temporal y código de sesión: cuando los dos jugadores mandan
  // el suyo, hay que poder distinguirlos sin abrirlos.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const who = (input.session.pilotName ?? "pilot").replace(/[^a-zA-Z0-9_-]/g, "");
  const code = input.session.joinCode ?? "nosession";
  const filename = `we-connect-report_${code}_${who}_${stamp}.json`;

  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Liberar el object URL: sin esto el blob se queda retenido en memoria mientras
  // viva la pestaña, y el reporte puede pesar cientos de KB.
  setTimeout(() => URL.revokeObjectURL(url), 0);

  return filename;
}
