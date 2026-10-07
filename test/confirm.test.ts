import { describe, expect, it } from "vitest";
import { makeConfirmer, parseConfirmMode, systemDialog, type ConfirmDeps } from "../src/confirm.js";
import { checkGcode } from "../src/guard.js";
import type { Config } from "../src/config.js";

const req = { title: "t", message: "m" };
const mk = (d: Partial<ConfirmDeps> & { mode: ConfirmDeps["mode"] }) => makeConfirmer(d);

describe("makeConfirmer", () => {
  it("auto: uses elicitation first", async () => {
    const calls: string[] = [];
    const c = mk({ mode: "auto", elicit: async () => { calls.push("elicit"); return "accept"; }, dialog: async () => { calls.push("dialog"); return "yes"; } });
    expect(await c(req)).toMatchObject({ approved: true, via: "elicitation" });
    expect(calls).toEqual(["elicit"]);
  });
  it("auto: a declined elicitation is final and never falls through to the dialog", async () => {
    const c = mk({ mode: "auto", elicit: async () => "decline", dialog: async () => "yes" });
    expect(await c(req)).toMatchObject({ approved: false, via: "elicitation" });
  });
  it("auto: falls back to the system dialog when the client cannot elicit", async () => {
    const c = mk({ mode: "auto", elicit: async () => "unsupported", dialog: async () => "yes" });
    expect(await c(req)).toMatchObject({ approved: true, via: "dialog" });
    const d = mk({ mode: "auto", elicit: async () => "unsupported", dialog: async () => "no" });
    expect(await d(req)).toMatchObject({ approved: false, via: "dialog" });
  });
  it("auto: refuses when there is no way to ask, and says how to fix it", async () => {
    const c = mk({ mode: "auto", elicit: async () => "unsupported", dialog: async () => "unavailable" });
    const r = await c(req);
    expect(r.approved).toBe(false);
    expect(r.note).toMatch(/elicitation|DUET_CONFIRM/);
  });
  it("ignores the model's own confirm flag everywhere except in model mode", async () => {
    const asked = { ...req, modelConfirmed: true };
    for (const mode of ["auto", "elicit", "dialog", "deny"] as const) {
      const r = await mk({ mode, elicit: async () => "decline", dialog: async () => "no" })(asked);
      expect(r.approved).toBe(false);
    }
    expect(await mk({ mode: "model" })(asked)).toMatchObject({ approved: true, via: "model-flag" });
    expect((await mk({ mode: "model" })(req)).approved).toBe(false);
  });
  it("deny mode never approves, elicit mode needs a capable client", async () => {
    expect((await mk({ mode: "deny", elicit: async () => "accept" })(req)).approved).toBe(false);
    expect((await mk({ mode: "elicit", elicit: async () => "unsupported" })(req)).note).toMatch(/does not support/);
    expect((await mk({ mode: "dialog", dialog: async () => "unavailable" })(req)).note).toMatch(/no system dialog/);
  });
  it("parses the mode, unknown values mean auto", () => {
    expect(parseConfirmMode("model")).toBe("model");
    expect(parseConfirmMode("whatever")).toBe("auto");
    expect(parseConfirmMode(undefined)).toBe("auto");
  });
});

describe("systemDialog", () => {
  it("can be switched off with DUET_CONFIRM_DIALOG=never", async () => {
    expect(await systemDialog(5, "win32", { DUET_CONFIRM_DIALOG: "never" })(req)).toBe("unavailable");
  });
});

describe("guard verdicts for confirmation", () => {
  const cfg: Config = { host: "x", password: "", readOnly: false, cameras: {}, macros: [], maxTemp: { bed: 100, tool: 260 } };
  it("collects every approval reason in one verdict", () => {
    const v = checkGcode("M104 S200\nG28\nG91\nG1 Z80", cfg, undefined, false);
    expect(v.ok).toBe(false);
    if (!v.ok && v.confirmable) expect(v.reasons.length).toBe(3);
    else throw new Error("expected a confirmable verdict");
  });
  it("hard blocks are never confirmable", () => {
    const v = checkGcode("M104 S200\nM997", cfg, undefined, false);
    expect(v.ok).toBe(false);
    expect((v as { confirmable?: boolean }).confirmable).toBeFalsy();
  });
  it("after approval only the hard rules remain", () => {
    expect(checkGcode("M104 S200\nG28", cfg, undefined, true).ok).toBe(true);
    expect(checkGcode("M104 S300", cfg, undefined, true).ok).toBe(false); // over the temperature limit: no approval helps
  });
});
