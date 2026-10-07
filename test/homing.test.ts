import { describe, expect, it } from "vitest";
import { homeAxes, orderAxes } from "../src/homing.js";

describe("orderAxes", () => {
  it("homes Z first, then X, then Y", () => {
    expect(orderAxes(["Y", "X", "Z"])).toEqual(["Z", "X", "Y"]);
    expect(orderAxes(["y", "x"])).toEqual(["X", "Y"]);
    expect(orderAxes(["X", "X"])).toEqual(["X"]);
  });
});

function fake(opts: { triggered: boolean; releasesAfterBackoff?: boolean; neverIdle?: boolean }) {
  const sent: string[] = [];
  let triggered = opts.triggered;
  let homed = false;
  let busy = false;
  const d = {
    sent,
    async model(key: string) {
      if (key === "state.status") return opts.neverIdle && busy ? "busy" : "idle";
      if (key === "move.axes") return [{ letter: "X", homed: false }, { letter: "Y", homed, machinePosition: 0 }];
      if (key === "sensors.endstops") return [{ triggered: false }, { triggered }];
    },
    async gcode(code: string) {
      sent.push(code);
      if (code.startsWith("G1 H2") && opts.releasesAfterBackoff !== false) triggered = false;
      if (code.startsWith("G28")) { homed = true; busy = true; }
      return "";
    },
  };
  return d;
}
const fast = { sleep: async () => {}, timeoutMs: 5 };

describe("homeAxes", () => {
  it("backs off before approaching when the endstop is already triggered", async () => {
    const d = fake({ triggered: true });
    await homeAxes(d, ["Y"], fast);
    expect(d.sent).toEqual(["G91", "G1 H2 Y5 F600", "G90", "G28 Y"]);
  });
  it("homes directly when the endstop is free", async () => {
    const d = fake({ triggered: false });
    await homeAxes(d, ["Y"], fast);
    expect(d.sent).toEqual(["G28 Y"]);
  });
  it("aborts without homing if the endstop stays triggered after back-off", async () => {
    const d = fake({ triggered: true, releasesAfterBackoff: false });
    await expect(homeAxes(d, ["Y"], fast)).rejects.toThrow(/still triggered/);
    expect(d.sent).not.toContain("G28 Y");
    expect(d.sent).toContain("G90"); // absolute mode restored
  });
  it("sends M112 on timeout", async () => {
    const d = fake({ triggered: false, neverIdle: true });
    await expect(homeAxes(d, ["Y"], fast)).rejects.toThrow(/M112/);
    expect(d.sent).toContain("M112");
  });
});
