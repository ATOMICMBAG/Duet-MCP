import net from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityLog, describeRequest } from "../src/activity.js";
import { DuetClient, type RequestEvent } from "../src/duet.js";
import { buildCockpit } from "../src/cockpit.js";
import { bootServer, closeAll } from "./helpers/bootServer.js";
import { startMockDuet } from "./helpers/mockDuet.js";

afterEach(closeAll);

const req = (over: Partial<RequestEvent> = {}): RequestEvent => ({ t: 1000, kind: "gcode", detail: "M220 S50", ok: true, source: "speed profile", ...over });

describe("ActivityLog", () => {
  it("keeps the newest entries and lists them newest first", () => {
    const log = new ActivityLog(3);
    for (let i = 1; i <= 5; i++) log.add({ t: i, kind: "sent", source: "s", text: `m${i}`, level: "ok" });
    expect(log.size).toBe(3);
    expect(log.recent(10).map((e) => e.text)).toEqual(["m5", "m4", "m3"]);
    expect(log.recent(2).map((e) => e.text)).toEqual(["m5", "m4"]);
  });
});

describe("describeRequest", () => {
  it("turns G-code and uploads into entries and ignores reads", () => {
    expect(describeRequest(req())).toEqual({ t: 1000, kind: "sent", source: "speed profile", text: "M220 S50", level: "ok" });
    expect(describeRequest(req({ detail: "M104 T0 S0\nM140 S0" }))!.text).toBe("M104 T0 S0  |  M140 S0");
    expect(describeRequest(req({ kind: "upload", detail: "0:/gcodes/a.gcode", source: undefined }))).toMatchObject({ source: "server", text: "Upload to 0:/gcodes/a.gcode", level: "ok" });
    for (const kind of ["model", "list", "download"] as const) expect(describeRequest(req({ kind }))).toBeUndefined();
  });
  it("shows failures, clips long text and hides secrets", () => {
    const bad = describeRequest(req({ ok: false, detail: "M24", error: "Duet rejected \"M24\": Error: no job" }))!;
    expect(bad.level).toBe("error");
    expect(bad.text).toMatch(/^M24 {2}->/);
    expect(describeRequest(req({ detail: "G1 X1 ".repeat(100) }))!.text.length).toBeLessThanOrEqual(141);
    expect(describeRequest(req({ detail: 'M551 P"hunter2"' }))!.text).not.toMatch(/hunter2/);
  });
});

describe("DuetClient reports every request", () => {
  it("tells kind, outcome and who asked, and survives a hook that throws", async () => {
    const mock = await startMockDuet();
    try {
      const duet = new DuetClient(mock.host, "", { backoffMs: 1 });
      const events: RequestEvent[] = [];
      let who: string | undefined = "assistant: send_gcode";
      duet.sourceOf = () => who;
      duet.onRequest = (e) => events.push(e);

      await duet.gcode("M105");
      who = undefined;
      mock.state.nextGcodeReply = "Error: Pause the print first";
      await expect(duet.gcode("M0")).rejects.toThrow(/Pause the print/);
      await duet.model("state.status");
      await duet.list("0:/gcodes");

      const dir = mkdtempSync(join(tmpdir(), "act-"));
      writeFileSync(join(dir, "a.g"), "G28\n");
      await duet.upload(join(dir, "a.g"), "0:/gcodes/a.g");

      expect(events.map((e) => [e.kind, e.ok])).toEqual([["gcode", true], ["gcode", false], ["model", true], ["list", true], ["upload", true]]);
      expect(events[0]).toMatchObject({ detail: "M105", source: "assistant: send_gcode" });
      expect(events[1].error).toMatch(/rejected/);
      expect(events[1].source).toBeUndefined();

      duet.onRequest = () => { throw new Error("hook broke"); };
      await expect(duet.gcode("M105")).resolves.toBeDefined(); // a broken hook never breaks a request
      await duet.disconnect();
    } finally { await mock.close(); }
  }, 30000);
});

describe("cockpit state lists what was sent", () => {
  it("includes at most the 15 newest, with their kind and level", () => {
    const activity = Array.from({ length: 20 }, (_, n) => ({ t: n, kind: "sent" as const, source: "s", text: `c${n}`, level: "ok" as const }));
    const s = buildCockpit({ now: 1, readOnly: false, cameras: [], connection: { ok: true, text: "" }, events: [], activity });
    expect(s.sent).toHaveLength(15);
    expect(s.sent[0]).toEqual({ t: 0, kind: "sent", source: "s", text: "c0", level: "ok" });
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}
async function until<T>(fn: () => Promise<T | undefined>, ms = 15000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v !== undefined) return v; } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("the cockpit shows what the server sent and decided (simulated Duet)", () => {
  it("lists the assistant's commands with their source, the guard's refusals and the user's answers", async () => {
    const port = await freePort();
    const { call } = await bootServer({ readOnly: false, env: { DUET_VIEWER_PORT: String(port), DUET_IMAGE_DIR: join(mkdtempSync(join(tmpdir(), "pics-")), "p") } });
    const sent = async (): Promise<any[]> => {
      const r = await until(async () => { const x = await fetch(`http://127.0.0.1:${port}/api/cockpit`); return x.ok ? x : undefined; });
      return (await r.json() as any).sent;
    };

    expect((await call("send_gcode", { gcode: "M105" })).isError).toBe(false);
    expect((await call("send_gcode", { gcode: "M208 X999" })).isError).toBe(true); // blocked for good
    expect((await call("home_axes", {})).isError).toBe(false); // approved by the simulated user

    // the cockpit caches for 2.5 s: wait for a fresh answer that contains the last action
    const list = await until(async () => { const l = await sent(); return l.some((e) => /You approved: home axes/.test(e.text)) ? l : undefined; }, 15000);
    const text = list.map((e) => `${e.source} | ${e.text}`);
    expect(text.some((t) => /^assistant: send_gcode \| M105$/.test(t))).toBe(true);
    expect(list.find((e) => /Refused by the guard: M208/.test(e.text))).toMatchObject({ kind: "decision", level: "warn", source: "assistant: send_gcode" });
    expect(list.find((e) => /You approved: home axes/.test(e.text))).toMatchObject({ kind: "decision", level: "ok", source: "you" });
    expect(list.some((e) => e.source === "assistant: home_axes" && /^G28/.test(e.text))).toBe(true);
    expect(list[0].t).toBeGreaterThanOrEqual(list[list.length - 1].t); // newest first
    expect(JSON.stringify(list)).not.toMatch(/password/i);
  }, 60000);

  it("records a declined approval", async () => {
    const port = await freePort();
    const { call } = await bootServer({ readOnly: false, elicit: "decline", env: { DUET_VIEWER_PORT: String(port), DUET_IMAGE_DIR: join(mkdtempSync(join(tmpdir(), "pics-")), "p") } });
    expect((await call("home_axes", {})).isError).toBe(true);
    const list = await until(async () => {
      const x = await fetch(`http://127.0.0.1:${port}/api/cockpit`);
      const l = ((await x.json()) as any).sent as any[];
      return l.some((e) => /Not approved/.test(e.text)) ? l : undefined;
    }, 15000);
    expect(list.find((e) => /Not approved/.test(e.text))).toMatchObject({ kind: "decision", level: "warn", source: "you" });
    expect(list.some((e) => e.kind === "sent")).toBe(false); // nothing reached the machine
  }, 60000);
});
