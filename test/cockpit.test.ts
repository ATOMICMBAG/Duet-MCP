import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildCockpit, computeBanner, type CockpitInput } from "../src/cockpit.js";
import { COCKPIT_HTML, COCKPIT_JS } from "../src/cockpit-ui.js";
import type { Sample } from "../src/supervisor.js";
import { bootServer, closeAll } from "./helpers/bootServer.js";

afterEach(closeAll);

const sample = (over: Partial<Sample> = {}): Sample => ({
  t: 1000, status: "processing", filePosition: 250, fileSize: 1000, fileName: "0:/gcodes/cube tower.gcode", layer: 12, upTime: 3600, timeLeft: 540,
  heaters: [{ role: "bed", current: 55.2, target: 55, state: "active" }, { role: "tool", current: 219.6, target: 220, state: "active" }],
  ...over,
});
const input = (over: Partial<CockpitInput> = {}): CockpitInput => ({ now: 100_000, readOnly: false, cameras: ["bed"], connection: { ok: true, text: "connected" }, sample: sample(), events: [], ...over });
const ev = (t: number, level: "info" | "warning" | "error", code: string, message = "m") => ({ t, level, code, message });

describe("cockpit banner: what needs the user most", () => {
  it("is empty during a clean print", () => {
    expect(computeBanner(input())).toBeNull();
  });
  it("puts a lost connection above everything", () => {
    const b = computeBanner(input({ connection: { ok: false, text: "not reachable (timeout)" }, pendingApproval: { title: "x", since: 0 } }))!;
    expect(b.level).toBe("error");
    expect(b.text).toMatch(/not reachable/);
  });
  it("reports a halted machine as an error", () => {
    expect(computeBanner(input({ sample: sample({ status: "halted" }) }))).toMatchObject({ level: "error", title: "The machine is halted" });
  });
  it("tells the user that an approval waits in the chat", () => {
    const b = computeBanner(input({ pendingApproval: { title: "duet-mcp: start print", since: 100_000 - 150_000 } }))!;
    expect(b.title).toBe("Waiting for your approval in the chat");
    expect(b.text).toMatch(/start print \(3 min\)/);
    expect(b.text).toMatch(/answer the question in the chat/);
  });
  it("shows a filament change and tells the user to hurry", () => {
    const mb = { mode: 2, title: "Filament change", message: "Filament wechseln, dann OK druecken", timeout: 0 };
    const b = computeBanner(input({ sample: sample({ status: "pausing", messageBox: mb }) }))!;
    expect(b).toMatchObject({ level: "warning", title: "Filament change: the machine waits for you" });
    expect(b.text).toMatch(/hurry/);
    const other = computeBanner(input({ sample: sample({ status: "pausing", messageBox: { ...mb, title: "Check", message: "Bed clear?" } }) }))!;
    expect(other.title).toBe("The machine shows a message and waits");
  });
  it("shows a recent warning, but not an old one and not the ones the message banner already covers", () => {
    expect(computeBanner(input({ events: [ev(90_000, "warning", "no-progress", "stalled")] }))).toMatchObject({ level: "warning", title: "Notice: no-progress", text: "stalled" });
    expect(computeBanner(input({ events: [ev(-50_000, "warning", "no-progress")] }))).toBeNull(); // 150 s old: older than two minutes
    expect(computeBanner(input({ events: [ev(95_000, "warning", "filament-change")] }))).toBeNull();
    expect(computeBanner(input({ events: [ev(95_000, "info", "job-started")] }))).toBeNull();
  });
  it("says a paused job is paused, and warns when the nozzle is hot", () => {
    const hot = computeBanner(input({ sample: sample({ status: "paused" }) }))!;
    expect(hot).toMatchObject({ level: "info", title: "The job is paused" });
    expect(hot.text).toMatch(/nozzle is still hot \(220 C\)/);
    const cold = computeBanner(input({ sample: sample({ status: "paused", heaters: [{ role: "tool", current: 40, target: 0, state: "off" }] }) }))!;
    expect(cold.text).toMatch(/Continue with the chat/);
  });
});

describe("cockpit state", () => {
  it("collects the machine, heaters, fans, axes and endstops", () => {
    const s = buildCockpit(input({
      extra: { axes: [{ letter: "X", position: 120.04, homed: true }], speedPct: 80, endstops: [{ axis: "X", triggered: true }], fans: [{ name: "Part", pct: 30 }] },
      events: [ev(1, "info", "a"), ev(2, "info", "b")],
      pictures: { count: 5, newest: { file: "f.jpg", time: "2026-10-12 17:43:07", camera: "bed", auto: false }, recent: [] },
    }));
    expect(s.machine).toEqual({ status: "processing", job: "cube tower.gcode", layer: 12, progressPct: 25, timeLeftMin: 9, speedPct: 80, uptimeMin: 60 });
    expect(s.heaters.map((h) => [h.name, h.state, h.lit])).toEqual([["Bed", "holding", true], ["Nozzle", "holding", true]]);
    expect(s.fans).toEqual([{ name: "Part", pct: 30 }]);
    expect(s.endstops).toEqual([{ axis: "X", triggered: true }]);
    expect(s.events.map((e) => e.code)).toEqual(["b", "a"]); // newest first
    expect(s.pictures.count).toBe(5);
    expect(s.hints.join(" ")).toMatch(/only shows what is going on/);
    expect(s.hints.join(" ")).toMatch(/cannot call you/);
  });
  it("describes heaters: heating, off, still hot, fault", () => {
    const s = buildCockpit(input({ sample: sample({ status: "idle", heaters: [
      { role: "bed", current: 30, target: 55, state: "active" },
      { role: "tool", current: 120, target: 0, state: "off" },
      { role: "other", current: 22, target: 0, state: "fault" },
    ] }) }));
    expect(s.heaters.map((h) => h.state)).toEqual(["heating", "off, still hot", "FAULT"]);
    expect(s.heaters[1].hot).toBe(true);
    expect(s.machine.job).toBeUndefined(); // no job while idle
    expect(s.machine.progressPct).toBeUndefined();
  });
  it("works without any data and with a read-only server", () => {
    const s = buildCockpit({ now: 1, readOnly: true, cameras: [], connection: { ok: true, text: "" }, events: [] });
    expect(s.machine.status).toBe("unknown");
    expect(s.heaters).toEqual([]);
    expect(s.hints.join(" ")).toMatch(/read-only/);
    expect(s.hints.join(" ")).toMatch(/No camera is configured/);
  });
});

describe("cockpit page", () => {
  it("has no buttons or forms, no inline script, and writes values as text only", () => {
    expect(COCKPIT_HTML).not.toMatch(/<button|<form|<input|onclick|onload/i);
    expect(COCKPIT_HTML).toMatch(/<script src="app\.js"><\/script>/);
    expect(COCKPIT_HTML.match(/<script/g)).toHaveLength(1);
    expect(COCKPIT_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    expect(COCKPIT_JS).toMatch(/textContent/);
    expect(COCKPIT_JS).not.toMatch(/method:\s*["']POST/i); // the page only reads
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

describe("cockpit through the running server (simulated Duet)", () => {
  it("serves the page, the script and the data, from the machine's real values", async () => {
    const port = await freePort();
    const { mock } = await bootServer({ readOnly: true, initial: { status: "processing", job: { layer: 7, filePosition: 400, file: { size: 1000, fileName: "0:/gcodes/test.gcode" }, timesLeft: { file: 300 } } as any }, env: { DUET_VIEWER_PORT: String(port), DUET_IMAGE_DIR: "off" } });
    const base = `http://127.0.0.1:${port}`;
    // images are off here: the viewer needs a folder, so it is not started; see the next test
    await new Promise((r) => setTimeout(r, 500));
    expect(mock.state.status).toBe("processing");
    await expect(fetch(`${base}/api/cockpit`, { signal: AbortSignal.timeout(1500) })).rejects.toBeTruthy();
  }, 30000);

  it("data endpoint reflects heaters, axes, endstops, fans, speed and the filament-change banner", async () => {
    const port = await freePort();
    const { mock } = await bootServer({
      readOnly: true,
      initial: { status: "processing", job: { layer: 7, filePosition: 400, file: { size: 1000, fileName: "0:/gcodes/test.gcode" }, timesLeft: { file: 300 } } as any, speedFactor: 0.8 },
      env: { DUET_VIEWER_PORT: String(port), DUET_IMAGE_DIR: "pics-test" },
    });
    const base = `http://127.0.0.1:${port}`;
    const get = async (path: string) => until(async () => { const r = await fetch(base + path); return r.ok ? r : undefined; });

    const page = await get("/");
    expect(await page.text()).toMatch(/duet-mcp cockpit/);
    expect(page.headers.get("content-security-policy")).toMatch(/script-src 'self'/);
    expect((await (await get("/app.js")).text())).toMatch(/api\/cockpit/);

    // give the supervisor a moment to read the state
    const data: any = await until(async () => { const j: any = await (await fetch(`${base}/api/cockpit`)).json(); return j.machine.layer === 7 ? j : undefined; });
    expect(data.machine).toMatchObject({ status: "processing", job: "test.gcode", layer: 7, progressPct: 40, timeLeftMin: 5, speedPct: 80 });
    expect(data.heaters.map((h: any) => h.name)).toEqual(["Bed", "Nozzle"]);
    expect(data.fans).toEqual([{ name: "Part", pct: 30 }]);
    expect(data.axes.map((a: any) => [a.letter, a.homed])).toEqual([["X", true], ["Y", true], ["Z", true]]);
    expect(data.endstops).toEqual([{ axis: "X", triggered: false }]);
    expect(data.banner).toBeNull();

    // the machine asks for a filament change
    mock.state.status = "pausing";
    mock.state.messageBox = { mode: 2, title: "Filament change", message: "Filament wechseln, dann OK druecken", timeout: 0 };
    const waiting: any = await until(async () => { const j: any = await (await fetch(`${base}/api/cockpit`)).json(); return j.banner?.title?.startsWith("Filament change") ? j : undefined; }, 20000);
    expect(waiting.banner.level).toBe("warning");
    expect(waiting.events.some((e: any) => e.code === "filament-change")).toBe(true);

    // the old gallery still exists, and the Host check also covers the data endpoint
    expect((await get("/pictures")).headers.get("content-type")).toMatch(/text\/html/);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/cockpit", headers: { host: "evil.example.com" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject); req.end();
    });
    expect(status).toBe(403);
  }, 90000);
});
