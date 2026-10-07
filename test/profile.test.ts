import { describe, expect, it } from "vitest";
import { mergeLive, parseConfig, redactSecrets } from "../src/profile.js";
import { parseCameras } from "../src/camera.js";

describe("redactSecrets", () => {
  it("hides DWC and WiFi passwords but keeps other lines", () => {
    const out = redactSecrets('M551 P"geheim123"\nM552 S1\nM587 S"Home" P"wlankey"\nM550 P"Printer"');
    expect(out).not.toContain("geheim123");
    expect(out).not.toContain("wlankey");
    expect(out).toContain("M552 S1");
    expect(out).toContain('M550 P"Printer"');
  });
});

describe("parseConfig command word", () => {
  it("does not treat the command itself as a parameter", () => {
    const p = parseConfig("M208 X0 S1\nM92 X80\nM906 X800");
    expect(p.axisLimits.M).toBeUndefined();
    expect(p.stepsPerMm.M).toBeUndefined();
    expect(p.motorCurrent.M).toBeUndefined();
  });
});

describe("mergeLive", () => {
  it("prefers the limits the firmware reports", () => {
    const base = parseConfig("M208 X0 Y0 S1\nM208 X220 Y220 S0\nM143 H1 S280");
    const p = mergeLive(base, [{ letter: "X", min: 0, max: 200 }], [{ max: 120 }, { max: 250 }]);
    expect(p.axisLimits.X).toEqual({ min: 0, max: 200 });
    expect(p.axisLimits.Y).toEqual({ min: 0, max: 220 });
    expect(p.heaterMaxTemp["1"]).toBe(250);
  });
});

describe("parseCameras", () => {
  it("handles single and named cameras", () => {
    expect(parseCameras({ DUET_CAMERA_URL: "http://a/shot.jpg", DUET_CAMERAS: "top=dshow:Phone Cam,side=rtsp://x/y" })).toEqual({
      default: "http://a/shot.jpg",
      top: "dshow:Phone Cam",
      side: "rtsp://x/y",
    });
  });
});
