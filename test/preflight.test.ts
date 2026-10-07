import { describe, expect, it } from "vitest";
import { analyzeGcode, applyFixes, formatReport } from "../src/preflight.js";
import { parseConfig } from "../src/profile.js";

const profile = parseConfig("M208 X0 Y0 Z0 S1\nM208 X220 Y220 Z240 S0");
const maxTemp = { bed: 100, tool: 260 };
const opt = { profile, maxTemp };

/** Builds a small valid file; extrusion amounts follow a 0.4 mm line at 0.2 mm layers for 1.75 mm filament. */
function make(parts: { start?: string; layers?: number; end?: string } = {}) {
  const start = parts.start ?? "T0\nM140 S55\nM190 S55\nM104 S210\nM109 S210\nM82\nG92 E0";
  const end = parts.end ?? "M104 S0\nM140 S0\nM84";
  const perMm = (0.4 * 0.2) / (Math.PI * (1.75 / 2) ** 2);
  const lines = [";FLAVOR:Marlin", ";Layer height: 0.2", ";Generated with Cura_SteamEngine 5.7.2", start];
  let e = 0;
  for (let l = 0; l < (parts.layers ?? 4); l++) {
    const z = (0.2 * (l + 1)).toFixed(2);
    lines.push(`;LAYER:${l}`, `G0 F6000 X50 Y50 Z${z}`);
    for (let k = 0; k < 5; k++) { e += 10 * perMm; lines.push(`G1 F1800 X${60 + k * 10} Y50 E${e.toFixed(5)}`); }
  }
  lines.push(end);
  return lines.join("\n");
}

describe("analyzeGcode", () => {
  it("accepts a clean file", () => {
    const r = analyzeGcode(make(), { ...opt, nozzle: 0.4 });
    expect(r.verdict).toBe("ok");
    expect(r.summary.maxToolTemp).toBe(210);
    expect(r.summary.layerHeight).toBe(0.2);
    expect(r.summary.estLineWidth).toBeCloseTo(0.4, 1);
  });
  it("warns when no tool is selected before M104/M109", () => {
    const r = analyzeGcode(make({ start: "M140 S55\nM190 S55\nM104 S210\nM109 S210\nG92 E0" }), opt);
    expect(r.findings.map((f) => f.code)).toContain("no-tool-select");
    expect(r.summary.needsToolSelect).toBe(true);
  });
  it("does not warn when T is given in the command or a tool is selected", () => {
    expect(analyzeGcode(make({ start: "M104 T0 S210\nM109 T0 S210" }), opt).summary.needsToolSelect).toBe(false);
  });
  it("flags G28 in the start block", () => {
    const r = analyzeGcode(make({ start: "T0\nG28\nM104 S210\nM109 S210" }), opt);
    expect(r.findings.map((f) => f.code)).toContain("g28-in-start");
  });
  it("does not flag G28 at the end", () => {
    const r = analyzeGcode(make({ end: "M104 S0\nM140 S0\nG28 X0 Y0\nM84" }), opt);
    expect(r.findings.map((f) => f.code)).not.toContain("g28-in-start");
  });
  it("errors on over-temperature even if the machine would be able", () => {
    const r = analyzeGcode(make({ start: "T0\nM104 S300\nM109 S300" }), opt);
    expect(r.verdict).toBe("errors");
    expect(r.findings.some((f) => f.code === "over-temp")).toBe(true);
  });
  it("errors on moves outside the machine limits", () => {
    const text = make() + "\nG1 X400 Y10 E999";
    const r = analyzeGcode(text, opt);
    expect(r.findings.find((f) => f.code === "out-of-bounds")?.message).toMatch(/X400/);
  });
  it("errors on extrusion without any heating", () => {
    const r = analyzeGcode(make({ start: "T0\nG92 E0" }), opt);
    expect(r.findings.map((f) => f.code)).toContain("no-heat-before-extrusion");
  });
  it("warns when heaters are not switched off at the end", () => {
    const r = analyzeGcode(make({ end: "M84" }), opt);
    expect(r.findings.map((f) => f.code)).toContain("heaters-stay-on");
  });
  it("finds config/firmware commands in a print file", () => {
    const r = analyzeGcode(make({ start: "T0\nM104 S210\nM109 S210\nM997\nM92 E100" }), opt);
    const blocked = r.findings.filter((f) => f.code === "blocked-command");
    expect(blocked.find((f) => /M997/.test(f.message))?.severity).toBe("error");
    expect(blocked.find((f) => /M92/.test(f.message))?.severity).toBe("warning");
  });
  it("judges the line width against the nozzle", () => {
    const r = analyzeGcode(make(), { ...opt, nozzle: 1.0 });
    expect(r.findings.find((f) => f.code === "line-width")?.severity).toBe("warning");
  });
  it("reports an empty file as having no extrusion", () => {
    expect(analyzeGcode("; nothing\nM105", opt).findings.map((f) => f.code)).toContain("no-extrusion");
  });
});

describe("applyFixes", () => {
  const broken = make({ start: "M140 S55\nM190 S55\nG28\nM104 S210\nM109 S210\nG92 E0", end: "M104 S0\nM140 S0\nG28 X0 Y0\nM84" });
  it("selects the tool and strips the start G28 but keeps the end G28", () => {
    const r = analyzeGcode(broken, opt);
    const { text, changes } = applyFixes(broken, r, ["select-tool", "strip-g28"]);
    expect(changes.length).toBe(2);
    const lines = text.split("\n");
    expect(lines.some((l) => l.startsWith("T0 ;added by duet-mcp"))).toBe(true);
    expect(lines.filter((l) => /^G28/.test(l))).toEqual(["G28 X0 Y0"]);
    expect(analyzeGcode(text, opt).verdict).toBe("ok");
  });
  it("only does what was asked", () => {
    const r = analyzeGcode(broken, opt);
    const { text } = applyFixes(broken, r, ["strip-g28"]);
    expect(text).not.toContain("T0 ;added");
  });
  it("keeps CRLF line endings", () => {
    const crlf = broken.replace(/\n/g, "\r\n");
    const { text } = applyFixes(crlf, analyzeGcode(crlf, opt), ["select-tool"]);
    expect(text.split("\r\n").length).toBe(crlf.split("\r\n").length + 1);
  });
});

describe("formatReport", () => {
  it("lists errors before warnings", () => {
    const text = formatReport(analyzeGcode(make({ start: "M104 S300\nM109 S300" }), opt), "x.gcode");
    expect(text.indexOf("[ERROR]")).toBeLessThan(text.indexOf("[WARNING]"));
  });
});
