/** Minimal surface of DuetClient that homing needs (lets tests use a fake). */
export interface HomingDuet {
  model(key: string): Promise<any>;
  gcode(code: string): Promise<string>;
}

export interface HomingOptions {
  backoffMm?: number; // distance to move away from an already-triggered endstop
  awayDir?: Record<string, 1 | -1>; // direction that leads AWAY from the endstop (default +1 = endstops at the low end)
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** Z first (lifts the head clear of the bed), then X, then Y; other axes after. Duplicates removed. */
export function orderAxes(axes: string[]): string[] {
  const rank = (a: string) => { const i = "ZXY".indexOf(a); return i < 0 ? 99 : i; };
  return [...new Set(axes.map((a) => a.toUpperCase()))].sort((a, b) => rank(a) - rank(b));
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitIdle(d: HomingDuet, timeoutMs: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const t0 = Date.now();
  await sleep(1000); // status lags a moment behind the command
  for (;;) {
    if ((await d.model("state.status")) === "idle") return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(500);
  }
}

/**
 * Homes the given axes one by one.
 * Rule: if an axis' endstop is already triggered, first move a few mm AWAY from it, verify it released,
 * and only then approach it (never press into an endstop that is already pressed).
 * On timeout the machine gets an emergency stop (M112).
 */
export async function homeAxes(d: HomingDuet, axes: string[], opt: HomingOptions = {}): Promise<string[]> {
  const { backoffMm = 5, awayDir = {}, timeoutMs = 150_000, sleep = realSleep } = opt;
  const out: string[] = [];
  const log = (l: string) => { out.push(l); opt.log?.(l); };

  for (const axis of axes.map((a) => a.toUpperCase())) {
    const status = await d.model("state.status");
    if (status !== "idle") throw new Error(`Machine is "${status}", not idle. Stopping before ${axis}.`);

    const info = await d.model("move.axes");
    const idx = info.findIndex((a: any) => a.letter === axis);
    if (idx < 0) throw new Error(`Axis ${axis} does not exist on this machine.`);
    const endstops = await d.model("sensors.endstops");

    if (endstops[idx]?.triggered) {
      const dir = awayDir[axis] ?? 1;
      log(`${axis}: endstop already triggered -> backing off ${backoffMm} mm first`);
      try {
        await d.gcode("G91");
        await d.gcode(`G1 H2 ${axis}${dir * backoffMm} F600`);
      } finally {
        await d.gcode("G90");
      }
      if (!(await waitIdle(d, 20_000, sleep))) throw new Error(`${axis}: back-off move did not finish.`);
      if ((await d.model("sensors.endstops"))[idx]?.triggered) {
        throw new Error(`${axis}: endstop still triggered after backing off ${backoffMm} mm. Wrong direction, polarity or wiring - not homing.`);
      }
    }

    log(`${axis}: G28 ${axis}`);
    await d.gcode(`G28 ${axis}`);
    if (!(await waitIdle(d, timeoutMs, sleep))) {
      await d.gcode("M112");
      throw new Error(`${axis}: homing did not finish within ${timeoutMs / 1000}s -> emergency stop (M112) sent.`);
    }
    const after = (await d.model("move.axes"))[idx];
    if (!after?.homed) throw new Error(`${axis}: homing finished but axis is not marked homed. Check macros/endstop.`);
    log(`${axis}: homed, machine position ${after.machinePosition}`);
  }
  return out;
}
