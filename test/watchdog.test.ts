import { describe, expect, it } from "vitest";
import { HeatWatchdog } from "../src/watchdog.js";

const MIN = 60_000;
describe("HeatWatchdog", () => {
  it("triggers after the idle-heating time", () => {
    const w = new HeatWatchdog(10);
    expect(w.tick({ status: "idle", anyTargetOn: true }, 0)).toBe(false);
    expect(w.tick({ status: "idle", anyTargetOn: true }, 9 * MIN)).toBe(false);
    expect(w.tick({ status: "idle", anyTargetOn: true }, 10 * MIN)).toBe(true);
  });
  it("resets while a job is running or heaters are off", () => {
    const w = new HeatWatchdog(10);
    w.tick({ status: "idle", anyTargetOn: true }, 0);
    expect(w.tick({ status: "processing", anyTargetOn: true }, 8 * MIN)).toBe(false);
    expect(w.tick({ status: "idle", anyTargetOn: true }, 12 * MIN)).toBe(false); // restarted counting
    expect(w.tick({ status: "idle", anyTargetOn: false }, 30 * MIN)).toBe(false);
  });
  it("is disabled with 0 minutes", () => {
    const w = new HeatWatchdog(0);
    w.tick({ status: "idle", anyTargetOn: true }, 0);
    expect(w.tick({ status: "idle", anyTargetOn: true }, 999 * MIN)).toBe(false);
  });
});
