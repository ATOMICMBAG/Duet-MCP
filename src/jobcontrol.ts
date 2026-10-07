import type { HomingDuet } from "./homing.js";

export interface JobOptions {
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(d: HomingDuet, wanted: string[], timeoutMs: number, sleep: (ms: number) => Promise<void>): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const st: string = await d.model("state.status");
    if (wanted.includes(st) || Date.now() - t0 > timeoutMs) return st;
    await sleep(500);
  }
}

/**
 * Cancels the running job. The firmware refuses M0 unless the job is paused first
 * ("Pause the print before attempting to cancel it"), so a running job is paused (M25) before M0.
 * Heater targets are left alone on purpose (a restart may follow); the idle watchdog switches them off.
 */
export async function cancelJob(d: HomingDuet, opt: JobOptions = {}): Promise<string> {
  const { sleep = realSleep, timeoutMs = 30_000 } = opt;
  let st: string = await d.model("state.status");
  if (st === "idle") return "No job is running (status idle). Nothing to cancel.";
  if (st === "cancelling") {
    st = await waitFor(d, ["idle"], timeoutMs, sleep);
    return st === "idle" ? "Job was already being cancelled; machine is idle." : `Still "${st}" after waiting for the cancel to finish.`;
  }
  if (st === "processing" || st === "pausing" || st === "resuming") {
    if (st === "processing") await d.gcode("M25");
    st = await waitFor(d, ["paused"], timeoutMs, sleep);
  }
  if (st !== "paused") throw new Error(`Cannot cancel: machine status is "${st}" (expected a running or paused job).`);
  await d.gcode("M0");
  st = await waitFor(d, ["idle"], timeoutMs, sleep);
  if (st !== "idle") throw new Error(`M0 was sent but the machine is "${st}", not idle. Check DWC.`);
  return "Job cancelled; machine is idle. Heater targets were NOT changed.";
}

/**
 * Resumes a paused job (M24). resume.g normally extrudes 10 mm to undo the pause retraction. That is wrong when:
 *  - the pause happened before the first layer (nothing printed yet, the 10 mm would be pushed out into the air), or
 *  - the heaters are not at temperature (cold extrusion is refused, the job state gets out of sync).
 * In both cases cancelling and restarting is cleaner, so resuming needs force=true.
 */
export async function resumeJob(d: HomingDuet, force = false): Promise<string> {
  const st: string = await d.model("state.status");
  if (st !== "paused") throw new Error(`Cannot resume: machine status is "${st}", not paused.`);
  if (!force) {
    const job = await d.model("job");
    if (!job?.layer || job.layer <= 0) {
      throw new Error("The job was paused before the first layer. Resuming would extrude 10 mm into the air (resume.g). Use cancel_job and start again, or pass force=true.");
    }
    const heaters: any[] = await d.model("heat.heaters");
    const cold = heaters.find((h) => h?.active > 0 && h.current < h.active - 10);
    if (cold) throw new Error(`A heater is not at temperature (${cold.current} of ${cold.active} C). Wait for it, or pass force=true.`);
  }
  await d.gcode("M24");
  return "Resumed (M24).";
}
