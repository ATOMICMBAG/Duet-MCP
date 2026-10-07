/**
 * What we know about the connected board and firmware, and how far this server has been verified against it.
 * Verified so far (by the author): Duet 2 WiFi with RepRapFirmware 3.2.x in standalone mode. Everything else is "expected" from the
 * documented HTTP API and the official connector, but not tested. See README, section "Kompatibilität".
 */
export type Support = "tested" | "expected" | "unsupported" | "unknown";

export interface CompatInfo {
  board: string;
  firmware: string;
  support: Support;
  summary: string;
  notes: string[];
}

export interface CompatInput {
  apiLevel?: number;
  emulated?: boolean; // rr_connect isEmulated: the rr_ API is emulated by DuetWebServer (single board computer mode)
}

export function describeCompat(boards: any[] | undefined, input: CompatInput = {}): CompatInfo {
  const main = Array.isArray(boards) ? boards[0] : undefined;
  const board: string = main?.name ?? main?.shortName ?? "unknown board";
  const short: string = main?.shortName ?? "";
  const firmware: string = main?.firmwareVersion ?? "unknown";
  const m = /^(\d+)\.(\d+)/.exec(firmware);
  const major = m ? +m[1] : undefined;
  const minor = m ? +m[2] : undefined;
  const notes: string[] = [];
  const done = (support: Support, summary: string): CompatInfo => ({ board, firmware, support, summary, notes });

  if (input.emulated) {
    notes.push("The rr_ API is emulated by DuetWebServer (Duet 3 with a single board computer). That mode is not supported yet; planned via the REST API of the Duet Software Framework.");
    return done("unsupported", `${board}, firmware ${firmware}: single board computer mode is not supported`);
  }
  if (major === undefined) {
    notes.push("The firmware version could not be read from the object model.");
    return done("unknown", `${board}: firmware version unknown`);
  }
  if (major < 3) {
    notes.push("RepRapFirmware 2.x has no object model. duet-mcp needs RepRapFirmware 3.x.");
    return done("unsupported", `${board}, firmware ${firmware}: too old (needs 3.x)`);
  }

  const isDuet2 = /^2(WiFi|Ethernet|Maestro)/i.test(short) || /Duet 2|Maestro/i.test(board);
  const isDuet3 = /^(MB6|Mini5|6HC|6XD|Mini)/i.test(short) || /Duet 3|MB6|Mini 5/i.test(board);
  if (isDuet2 && /^2WiFi/i.test(short) && major === 3 && minor === 2) {
    notes.push("This is the combination the author tested (Duet 2 WiFi, RepRapFirmware 3.2.x, standalone, Cartesian).");
    return done("tested", `${board}, firmware ${firmware}: tested`);
  }
  notes.push("Only a Duet 2 WiFi with RepRapFirmware 3.2.x has been tested by the author.");
  if (isDuet3) notes.push("Duet 3 in standalone mode (Mini 5+, MB6HC, MB6XD) uses the same HTTP API; expansion and tool boards are read through the main board's object model.");
  if (!isDuet2 && !isDuet3) notes.push("Unknown board type: treated like a standard Duet with the 3.x HTTP API.");
  if (major === 3 && minor !== undefined && minor < 2) notes.push("Older than the tested 3.2: some object model fields may be missing.");
  if (major > 3 || (major === 3 && minor !== undefined && minor > 6)) notes.push("Newer than any version this was written against: please report problems.");
  return done("expected", `${board}, firmware ${firmware}: expected to work, not tested`);
}

export function formatCompat(c: CompatInfo): string {
  return [`${c.summary} [${c.support}]`, ...c.notes.map((n) => `  - ${n}`)].join("\n");
}
