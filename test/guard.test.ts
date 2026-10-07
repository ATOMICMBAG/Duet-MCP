import { describe, expect, it } from "vitest";
import { checkGcode } from "../src/guard.js";
import { parseConfig } from "../src/profile.js";
import type { Config } from "../src/config.js";

const cfg: Config = { host: "x", password: "", readOnly: false, cameras: {}, macros: ["eject.g"], maxTemp: { bed: 100, tool: 260 } };
const profile = parseConfig("M208 X0 Y0 Z0 S1\nM208 X200 Y200 Z180 S0 ; max\nM143 H1 S280\nM906 X800 Y800");

describe("parseConfig", () => {
  it("reads limits and heater max", () => {
    expect(profile.axisLimits.X).toEqual({ min: 0, max: 200 });
    expect(profile.heaterMaxTemp["1"]).toBe(280);
    expect(profile.motorCurrent.X).toBe(800);
  });
});

describe("checkGcode", () => {
  it("allows harmless commands", () => expect(checkGcode("M105", cfg, profile, false).ok).toBe(true));
  it("always allows M112", () => expect(checkGcode("M112", cfg, profile, false).ok).toBe(true));
  it("blocks config changes even when confirmed", () => expect(checkGcode("M208 X500 S0", cfg, profile, true).ok).toBe(false));
  it("requires confirm for heating", () => {
    expect(checkGcode("M104 S200", cfg, profile, false).ok).toBe(false);
    expect(checkGcode("M104 S200", cfg, profile, true).ok).toBe(true);
  });
  it("rejects over-temperature even when confirmed", () => expect(checkGcode("M140 S120", cfg, profile, true).ok).toBe(false));
  it("allows turning heaters off", () => expect(checkGcode("M140 S0", cfg, profile, false).ok).toBe(true));
  it("enforces axis limits on absolute moves", () => {
    expect(checkGcode("G1 X250", cfg, profile, false).ok).toBe(false);
    expect(checkGcode("G1 X100 Y100", cfg, profile, false).ok).toBe(true);
  });
  it("limits large relative moves", () => expect(checkGcode("G91\nG1 Z80", cfg, profile, false).ok).toBe(false));
  it("does not trust the XYZ box on non-Cartesian kinematics", () => {
    const delta = { ...profile, kinematics: "delta" };
    expect(checkGcode("G1 X10", cfg, delta, false).ok).toBe(false);
    expect(checkGcode("G1 X10", cfg, delta, true).ok).toBe(true);
    expect(checkGcode("G1 X10", cfg, { ...profile, kinematics: "coreXY" }, false).ok).toBe(true);
    expect(checkGcode("G1 X10", cfg, { ...profile, kinematics: "cartesian" }, false).ok).toBe(true);
  });
  it("rejects absolute moves on unhomed axes", () => {
    expect(checkGcode("G1 X10", cfg, profile, false, { X: false }).ok).toBe(false);
    expect(checkGcode("G1 X10", cfg, profile, false, { X: true }).ok).toBe(true);
  });
  it("requires confirm for homing and raw endstop moves", () => {
    expect(checkGcode("G28", cfg, profile, false).ok).toBe(false);
    expect(checkGcode("G28 X", cfg, profile, true).ok).toBe(true);
    expect(checkGcode("G1 H1 X-300", cfg, profile, false).ok).toBe(false);
  });
  it("only runs allowlisted macros", () => {
    expect(checkGcode('M98 P"eject.g"', cfg, profile, false).ok).toBe(true);
    expect(checkGcode('M98 P"config.g"', cfg, profile, true).ok).toBe(false);
  });
});
