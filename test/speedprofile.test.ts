import { describe, expect, it } from "vitest";
import { SpeedGovernor, formatSpeedProfile, parseSpeedProfile, speedFor } from "../src/speedprofile.js";

describe("parseSpeedProfile", () => {
  it("parses layer:percent pairs in any order", () => {
    expect(parseSpeedProfile("3:80, 1:30,2:50 ,6:100%")).toEqual([
      { fromLayer: 1, percent: 30 }, { fromLayer: 2, percent: 50 }, { fromLayer: 3, percent: 80 }, { fromLayer: 6, percent: 100 },
    ]);
  });
  it("treats off and empty as no profile", () => {
    expect(parseSpeedProfile("off")).toEqual([]);
    expect(parseSpeedProfile("")).toEqual([]);
    expect(parseSpeedProfile(undefined)).toEqual([]);
  });
  it("runs layers before the first step at 100 %", () => {
    expect(parseSpeedProfile("3:50")).toEqual([{ fromLayer: 1, percent: 100 }, { fromLayer: 3, percent: 50 }]);
  });
  it("rejects nonsense", () => {
    expect(() => parseSpeedProfile("1:5")).toThrow(/outside the allowed range/);
    expect(() => parseSpeedProfile("1:300")).toThrow(/outside/);
    expect(() => parseSpeedProfile("0:50")).toThrow(/starting at 1/);
    expect(() => parseSpeedProfile("a:b")).toThrow(/Cannot parse/);
    expect(() => parseSpeedProfile("1:50,1:60")).toThrow(/twice/);
  });
  it("formats", () => expect(formatSpeedProfile(parseSpeedProfile("1:30,2:50"))).toBe("from layer 1: 30 %, from layer 2: 50 %"));
});

describe("speedFor", () => {
  const p = parseSpeedProfile("1:30,2:50,3:80,6:100");
  it("picks the step that applies", () => {
    expect([1, 2, 3, 5, 6, 40].map((l) => speedFor(p, l))).toEqual([30, 50, 80, 80, 100, 100]);
  });
});

describe("SpeedGovernor", () => {
  const run = (g: SpeedGovernor, seq: [string, number | null][]) => seq.map(([status, layer]) => g.step({ status, layer }).set);

  it("sets each step once and resets after the job", () => {
    const g = new SpeedGovernor(parseSpeedProfile("1:30,2:50,3:80,6:100"));
    const out = run(g, [["idle", null], ["processing", 0], ["processing", 1], ["processing", 1], ["processing", 2], ["processing", 3], ["processing", 4], ["processing", 6], ["processing", 7], ["idle", null], ["idle", null]]);
    expect(out).toEqual([undefined, undefined, 30, undefined, 50, 80, undefined, 100, undefined, 100, undefined]);
  });
  it("respects a manual change until the next step", () => {
    const g = new SpeedGovernor(parseSpeedProfile("1:30,3:80"));
    run(g, [["processing", 1]]);
    // the user sets 60 % by hand in DWC: the governor sees the same layer and does not interfere
    expect(g.step({ status: "processing", layer: 1 }).set).toBeUndefined();
    expect(g.step({ status: "processing", layer: 2 }).set).toBeUndefined();
    expect(g.step({ status: "processing", layer: 3 }).set).toBe(80);
  });
  it("does not resend after pause and resume on the same layer", () => {
    const g = new SpeedGovernor(parseSpeedProfile("1:30,2:50"));
    expect(run(g, [["processing", 2], ["pausing", 2], ["paused", 2], ["resuming", 2], ["processing", 2]])).toEqual([50, undefined, undefined, undefined, undefined]);
  });
  it("does nothing without a profile and never resets what it did not set", () => {
    const g = new SpeedGovernor([]);
    expect(run(g, [["processing", 1], ["processing", 2], ["idle", null]])).toEqual([undefined, undefined, undefined]);
  });
  it("starts the next job from scratch", () => {
    const g = new SpeedGovernor(parseSpeedProfile("1:30"));
    run(g, [["processing", 1], ["idle", null]]);
    expect(g.step({ status: "processing", layer: 1 }).set).toBe(30);
  });
  it("primes the first step before the job and does not send it again at layer 1", () => {
    const g = new SpeedGovernor(parseSpeedProfile("1:30,2:50"));
    expect(g.prime()).toBe(30);
    expect(run(g, [["processing", 1], ["processing", 1], ["processing", 2], ["idle", null]])).toEqual([undefined, undefined, 50, 100]);
  });
  it("prime does nothing without a profile and can be undone", () => {
    expect(new SpeedGovernor([]).prime()).toBeUndefined();
    const g = new SpeedGovernor(parseSpeedProfile("1:30"));
    g.prime(); g.unprime();
    expect(g.step({ status: "processing", layer: 1 }).set).toBe(30);
  });
  it("applies a new profile in the middle of a job at the current layer", () => {
    const g = new SpeedGovernor([]);
    g.step({ status: "processing", layer: 5 });
    g.setProfile(parseSpeedProfile("1:30,3:80"));
    expect(g.step({ status: "processing", layer: 5 }).set).toBe(80);
  });
});
