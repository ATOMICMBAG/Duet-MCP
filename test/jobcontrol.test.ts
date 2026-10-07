import { describe, expect, it } from "vitest";
import { cancelJob, resumeJob } from "../src/jobcontrol.js";

/** Tiny state machine that behaves like RepRapFirmware for pause/cancel/resume. */
function fakeDuet(start: string, opts: { layer?: number; heaters?: { active: number; current: number }[]; m0Fails?: boolean } = {}) {
  let status = start;
  let pollsUntilPaused = 0;
  const sent: string[] = [];
  return {
    sent,
    get status() { return status; },
    async model(key: string) {
      if (key === "state.status") {
        if (status === "pausing" && pollsUntilPaused-- <= 0) status = "paused";
        return status;
      }
      if (key === "job") return { layer: opts.layer ?? 5 };
      if (key === "heat.heaters") return opts.heaters ?? [{ active: 0, current: 22 }, { active: 220, current: 220 }];
    },
    async gcode(code: string) {
      sent.push(code);
      if (code === "M25" && status === "processing") { status = "pausing"; pollsUntilPaused = 1; }
      if (code === "M0") {
        if (status !== "paused" || opts.m0Fails) throw new Error('Duet rejected "M0": Error: M0: Pause the print before attempting to cancel it');
        status = "idle";
      }
      if (code === "M24" && status === "paused") status = "processing";
      return "";
    },
  };
}
const fast = { sleep: async () => {} };

describe("cancelJob", () => {
  it("pauses a running job first, then cancels it", async () => {
    const d = fakeDuet("processing");
    await cancelJob(d, fast);
    expect(d.sent).toEqual(["M25", "M0"]);
    expect(d.status).toBe("idle");
  });
  it("cancels a paused job directly", async () => {
    const d = fakeDuet("paused");
    await cancelJob(d, fast);
    expect(d.sent).toEqual(["M0"]);
  });
  it("does nothing when idle", async () => {
    const d = fakeDuet("idle");
    expect(await cancelJob(d, fast)).toMatch(/Nothing to cancel/);
    expect(d.sent).toEqual([]);
  });
  it("surfaces a rejected M0 instead of reporting success", async () => {
    const d = fakeDuet("paused", { m0Fails: true });
    await expect(cancelJob(d, fast)).rejects.toThrow(/rejected "M0"/);
  });
  it("refuses in states it does not understand", async () => {
    const d = fakeDuet("halted");
    await expect(cancelJob(d, fast)).rejects.toThrow(/halted/);
    expect(d.sent).toEqual([]);
  });
});

describe("resumeJob", () => {
  it("resumes a paused job that has printed and is hot", async () => {
    const d = fakeDuet("paused");
    await resumeJob(d);
    expect(d.sent).toEqual(["M24"]);
  });
  it("refuses when the job is not paused", async () => {
    await expect(resumeJob(fakeDuet("processing"))).rejects.toThrow(/not paused/);
  });
  it("refuses a pause before the first layer unless forced", async () => {
    const d = fakeDuet("paused", { layer: 0 });
    await expect(resumeJob(d)).rejects.toThrow(/before the first layer/);
    expect(d.sent).toEqual([]);
    await resumeJob(d, true);
    expect(d.sent).toEqual(["M24"]);
  });
  it("refuses while a heater is still far below its target unless forced", async () => {
    const d = fakeDuet("paused", { heaters: [{ active: 0, current: 22 }, { active: 220, current: 150 }] });
    await expect(resumeJob(d)).rejects.toThrow(/not at temperature/);
    await resumeJob(d, true);
    expect(d.sent).toEqual(["M24"]);
  });
});
