import { describe, expect, it } from "vitest";
import { ConnectionTracker, DEFAULT_SUPERVISOR, JobSupervisor, supervisorConfigFromEnv, type HeaterSample, type Sample } from "../src/supervisor.js";

const S = 1000;
const bed = (current: number, target = 55): HeaterSample => ({ role: "bed", current, target, state: "active" });
const tool = (current: number, target = 220): HeaterSample => ({ role: "tool", current, target, state: "active" });
function sample(t: number, status: string, heaters: HeaterSample[], pos = 100, extra: Partial<Sample> = {}): Sample {
  return { t, status, heaters, filePosition: pos, fileSize: 1000, fileName: "cube.gcode", ...extra };
}
const codes = (r: { events: { code: string }[] }) => r.events.map((e) => e.code);

describe("JobSupervisor", () => {
  it("stays quiet during a clean print and reports start and finish", () => {
    const sv = new JobSupervisor();
    expect(codes(sv.evaluate(sample(0, "processing", [bed(55), tool(220)], 10)))).toEqual(["job-started"]);
    for (let t = 10; t < 200; t += 10) {
      const r = sv.evaluate(sample(t * S, "processing", [bed(55.4), tool(219.8)], 10 + t));
      expect(r.events).toEqual([]);
      expect(r.actions).toEqual([]);
    }
    expect(codes(sv.evaluate(sample(210 * S, "processing", [bed(55), tool(220)], 990)))).toEqual([]);
    expect(codes(sv.evaluate(sample(220 * S, "idle", [bed(55), tool(220)], 0)))).toEqual(["job-finished"]);
  });

  it("does not raise a deviation while heating up from a stale lower target (the false alarm of the first print)", () => {
    const sv = new JobSupervisor();
    sv.evaluate(sample(0, "processing", [bed(40), tool(50, 50)], 5)); // old nozzle target 50 is already settled
    let all: string[] = [];
    // new target 220 arrives, nozzle needs 90 s to get there
    for (let k = 1; k <= 18; k++) {
      const r = sv.evaluate(sample(k * 5 * S, "processing", [bed(55), tool(50 + k * 9.5, 220)], 5));
      all = all.concat(codes(r));
      expect(r.actions).toEqual([]);
    }
    expect(all).toEqual([]);
  });

  it("pauses when the nozzle drifts away for longer than the deviation time", () => {
    const sv = new JobSupervisor();
    sv.evaluate(sample(0, "processing", [bed(55), tool(220)], 10));
    sv.evaluate(sample(10 * S, "processing", [bed(55), tool(220)], 20));
    let pausedAt = -1;
    for (let t = 20; t <= 120; t += 5) {
      const r = sv.evaluate(sample(t * S, "processing", [bed(55), tool(190)], 20 + t));
      if (r.actions.some((a) => a.type === "pause")) { pausedAt = t; break; }
    }
    expect(pausedAt).toBeGreaterThan(0);
    expect(pausedAt).toBeLessThanOrEqual(70); // deviation starts at t=20, 45 s later
  });

  it("fires an episode only once", () => {
    const sv = new JobSupervisor();
    sv.evaluate(sample(0, "processing", [tool(220)], 10));
    let count = 0;
    for (let t = 5; t < 300; t += 5) count += sv.evaluate(sample(t * S, "processing", [tool(150)], 10 + t)).actions.length;
    expect(count).toBe(1);
  });

  it("switches heaters off and pauses on over-temperature", () => {
    const sv = new JobSupervisor();
    sv.evaluate(sample(0, "processing", [tool(220)], 10));
    const r = sv.evaluate(sample(5 * S, "processing", [tool(270)], 20));
    expect(r.actions.map((a) => a.type)).toEqual(["heaters-off", "pause"]);
    expect(codes(r)).toContain("over-temperature");
  });

  it("switches heaters off on over-temperature when idle but has nothing to pause", () => {
    const sv = new JobSupervisor();
    const r = sv.evaluate(sample(0, "idle", [bed(120, 0)], 0));
    expect(r.actions.map((a) => a.type)).toEqual(["heaters-off"]);
  });

  it("detects a runaway once the heater had settled", () => {
    const sv = new JobSupervisor();
    sv.evaluate(sample(0, "idle", [tool(220)], 0));
    const r = sv.evaluate(sample(5 * S, "idle", [tool(250)], 0));
    expect(codes(r)).toContain("temperature-runaway");
  });

  it("does not call a cool-down after lowering the target a runaway", () => {
    const sv = new JobSupervisor();
    sv.evaluate(sample(0, "idle", [tool(220)], 0));
    const r = sv.evaluate(sample(5 * S, "idle", [tool(220, 180)], 0)); // target lowered, nozzle still hot
    expect(r.events).toEqual([]);
    expect(r.actions).toEqual([]);
  });

  it("pauses when a target is not reached within the heat-up time while printing", () => {
    const sv = new JobSupervisor({ ...DEFAULT_SUPERVISOR, heatupMinutes: 2 });
    sv.evaluate(sample(0, "processing", [tool(25, 220)], 5));
    expect(sv.evaluate(sample(100 * S, "processing", [tool(30, 220)], 5)).actions).toEqual([]);
    const r = sv.evaluate(sample(125 * S, "processing", [tool(30, 220)], 5));
    expect(codes(r)).toContain("heatup-timeout");
    expect(r.actions[0].type).toBe("pause");
  });

  it("warns about a stalled job but not while heating, and can pause instead", () => {
    const sv = new JobSupervisor();
    sv.evaluate(sample(0, "processing", [tool(100, 220)], 5)); // heating: position stays put
    expect(sv.evaluate(sample(400 * S, "processing", [tool(100, 220)], 5)).events.filter((e) => e.code === "no-progress")).toEqual([]);
    const sv2 = new JobSupervisor();
    sv2.evaluate(sample(0, "processing", [tool(220)], 50));
    const r = sv2.evaluate(sample(200 * S, "processing", [tool(220)], 50));
    expect(r.events.find((e) => e.code === "no-progress")?.level).toBe("warning");
    expect(r.actions).toEqual([]);
    const sv3 = new JobSupervisor({ ...DEFAULT_SUPERVISOR, stallAction: "pause" });
    sv3.evaluate(sample(0, "processing", [tool(220)], 50));
    expect(sv3.evaluate(sample(200 * S, "processing", [tool(220)], 50)).actions[0].type).toBe("pause");
  });

  it("reports a job that ended early (cancelled, reset)", () => {
    const sv = new JobSupervisor();
    sv.evaluate(sample(0, "processing", [tool(220)], 100));
    sv.evaluate(sample(10 * S, "processing", [tool(220)], 400));
    const r = sv.evaluate(sample(20 * S, "idle", [tool(220)], 0));
    expect(r.events[0].code).toBe("job-ended-early");
    expect(r.events[0].message).toMatch(/40 %/);
  });

  it("reports an early end also when the job was cancelled from the paused state", () => {
    const sv = new JobSupervisor();
    sv.evaluate(sample(0, "processing", [tool(220)], 350));
    sv.evaluate(sample(10 * S, "processing", [tool(220)], 360));
    sv.evaluate(sample(15 * S, "paused", [tool(220)], 360));
    const r = sv.evaluate(sample(20 * S, "idle", [tool(220)], 0));
    expect(r.events.map((e) => e.code)).toEqual(["job-ended-early"]);
    expect(r.events[0].message).toMatch(/36 %/);
  });

  it("supervises again after a resume", () => {
    const sv = new JobSupervisor();
    sv.evaluate(sample(0, "processing", [tool(220)], 10));
    sv.evaluate(sample(10 * S, "processing", [tool(180)], 20));
    sv.evaluate(sample(60 * S, "processing", [tool(180)], 30)); // pause fired here
    sv.evaluate(sample(61 * S, "paused", [tool(180)], 30));
    const r = sv.evaluate(sample(70 * S, "processing", [tool(219)], 40));
    expect(codes(r)).toEqual(["job-resumed"]);
  });

  it("reports a heater fault and a halted machine", () => {
    const sv = new JobSupervisor();
    const r = sv.evaluate(sample(0, "processing", [{ role: "tool", current: 20, target: 220, state: "fault" }], 10));
    expect(codes(r)).toContain("heater-fault");
    expect(sv.evaluate(sample(5 * S, "halted", [tool(20, 0)], 0)).events.map((e) => e.code)).toContain("machine-halted");
  });
});

describe("restart detection", () => {
  it("reports a board restart and does not also report an early job end", () => {
    const sv = new JobSupervisor();
    sv.evaluate(sample(0, "processing", [tool(220)], 400, { upTime: 5000 }));
    sv.evaluate(sample(10 * S, "processing", [tool(220)], 410, { upTime: 5010 }));
    const r = sv.evaluate(sample(20 * S, "idle", [tool(22, 0)], 0, { upTime: 8 }));
    expect(r.events.map((e) => e.code)).toEqual(["duet-restarted"]);
    expect(r.events[0].message).toMatch(/41 %/);
    expect(r.events[0].message).toMatch(/resurrect\.g/);
  });
  it("stays quiet while the uptime keeps growing or is not reported", () => {
    const sv = new JobSupervisor();
    expect(sv.evaluate(sample(0, "idle", [tool(22, 0)], 0, { upTime: 100 })).events).toEqual([]);
    expect(sv.evaluate(sample(30 * S, "idle", [tool(22, 0)], 0, { upTime: 130 })).events).toEqual([]);
    expect(sv.evaluate(sample(60 * S, "idle", [tool(22, 0)], 0)).events).toEqual([]);
  });
  it("supervises the new job after a restart as a fresh start", () => {
    const sv = new JobSupervisor();
    sv.evaluate(sample(0, "processing", [tool(220)], 400, { upTime: 5000 }));
    sv.evaluate(sample(10 * S, "idle", [tool(22, 0)], 0, { upTime: 5 }));
    expect(sv.evaluate(sample(20 * S, "processing", [tool(220)], 10, { upTime: 15 })).events.map((e) => e.code)).toEqual(["job-started"]);
  });
});

describe("ConnectionTracker", () => {
  it("uses the error kind when given", () => {
    const c = new ConnectionTracker(60);
    expect(c.fail(0, "anything", "auth").map((e) => e.code)).toEqual(["auth-failed"]);
    const d = new ConnectionTracker(60);
    expect(d.fail(0, "mentions the password but is unreachable", "unreachable")).toEqual([]);
  });
  it("reports a loss only after the grace period, once, and the recovery", () => {
    const c = new ConnectionTracker(60);
    expect(c.fail(0, "timeout")).toEqual([]);
    expect(c.fail(30 * S, "timeout")).toEqual([]);
    expect(c.fail(61 * S, "timeout").map((e) => e.code)).toEqual(["connection-lost"]);
    expect(c.fail(90 * S, "timeout")).toEqual([]);
    expect(c.ok(100 * S).map((e) => e.code)).toEqual(["connection-restored"]);
    expect(c.ok(110 * S)).toEqual([]);
  });
  it("reports a rejected password immediately and only once", () => {
    const c = new ConnectionTracker(60);
    expect(c.fail(0, "rr_connect failed (err=1; 1=wrong password)").map((e) => e.code)).toEqual(["auth-failed"]);
    expect(c.fail(15 * S, "rr_connect failed (err=1; 1=wrong password)")).toEqual([]);
    expect(c.ok(20 * S).map((e) => e.code)).toEqual(["connection-restored"]);
  });
});

describe("supervisorConfigFromEnv", () => {
  it("reads overrides and keeps defaults", () => {
    const c = supervisorConfigFromEnv({ DUET_STALL_SECONDS: "90", DUET_STALL_ACTION: "pause" }, { bed: 100, tool: 250 });
    expect(c.stallSeconds).toBe(90);
    expect(c.stallAction).toBe("pause");
    expect(c.devTool).toBe(15);
    expect(c.maxTool).toBe(250);
  });
});
