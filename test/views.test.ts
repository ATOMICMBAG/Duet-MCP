import net from "node:net";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCockpit } from "../src/cockpit.js";
import { COCKPIT_JS } from "../src/cockpit-ui.js";
import { parseCrops } from "../src/crops.js";
import { QueryStats } from "../src/queries.js";
import { bootServer, closeAll } from "./helpers/bootServer.js";

afterEach(closeAll);

describe("parseCrops", () => {
  it("reads name=camera:x,y,w,h entries separated by semicolons", () => {
    expect(parseCrops("filament=bed:0.28,0.0,0.2,0.46; leds = bed : 0.53, 0.04, 0.12, 0.30")).toEqual([
      { name: "filament", camera: "bed", x: 0.28, y: 0, w: 0.2, h: 0.46 },
      { name: "leds", camera: "bed", x: 0.53, y: 0.04, w: 0.12, h: 0.3 },
    ]);
    expect(parseCrops(undefined)).toEqual([]);
  });
  it("ignores entries that are broken or reach outside the picture", () => {
    expect(parseCrops("a=bed:0.1,0.1,0.2;b=bed:x,0,0.1,0.1;c=bed:0.9,0,0.3,0.1;d=bed:0,0,0,0.1;e=bed:-0.1,0,0.2,0.2;noequals;f=:0,0,1,1")).toEqual([]);
    expect(parseCrops("whole=bed:0,0,1,1")).toHaveLength(1);
  });
  it("keeps at most six", () => {
    const raw = Array.from({ length: 9 }, (_, n) => `v${n}=bed:0,0,0.5,0.5`).join(";");
    expect(parseCrops(raw)).toHaveLength(6);
  });
});

describe("QueryStats", () => {
  const read = (t: number, source: string | undefined, kind: "model" | "list" | "download" | "gcode", detail: string) => ({ t, kind, detail, ok: true, source });

  it("counts reads by source with a rate and the main things read, and ignores G-code and uploads", () => {
    const q = new QueryStats(0);
    for (let i = 0; i < 10; i++) q.read(read(100_000 + i * 1000, "supervisor", "model", i % 2 ? "state" : "heat.heaters"));
    q.read(read(120_000, "cockpit page", "model", "move.axes"));
    q.read(read(121_000, "assistant: list_files", "list", "0:/gcodes"));
    q.read(read(122_000, "supervisor", "gcode", "M105")); // not a read
    const s = q.summary(125_000);
    expect(s.reads.map((r) => r.source)).toEqual(["assistant: list_files", "cockpit page", "supervisor"]); // most recent first
    const sup = s.reads.find((r) => r.source === "supervisor")!;
    expect(sup.count).toBe(10);
    expect(sup.perMinute).toBe(10); // all within the last minute
    expect(sup.what.sort()).toEqual(["model heat.heaters", "model state"]);
    expect(s.sinceT).toBe(0);
  });

  it("counts tool calls, newest first, and names reads without a source after the server", () => {
    const q = new QueryStats(0);
    q.tool("get_status", 1000); q.tool("job_status", 2000); q.tool("get_status", 3000);
    q.read(read(5, undefined, "download", "0:/sys/config.g"));
    const s = q.summary(10_000);
    expect(s.tools).toEqual([{ name: "get_status", count: 2, last: 3000 }, { name: "job_status", count: 1, last: 2000 }]);
    expect(s.reads[0].source).toBe("server");
  });

  it("does not grow without end and keeps the rate to the last minute", () => {
    const q = new QueryStats(0);
    for (let i = 0; i < 2000; i++) q.read(read(i * 1000, "supervisor", "model", "state"));
    const s = q.summary(2_000_000);
    expect(s.reads[0].count).toBe(2000);
    expect(s.reads[0].perMinute).toBeLessThanOrEqual(61);
  });
});

describe("cockpit state with views, queries and server info", () => {
  it("links each view to the newest picture of its camera", () => {
    const newest = { file: "2026-10-12_17-43-07_bed.jpg", time: "2026-10-12 17:43:07", camera: "bed", auto: false };
    const s = buildCockpit({
      now: 1, readOnly: false, cameras: ["bed", "Side view"], connection: { ok: true, text: "" }, events: [],
      crops: [{ name: "filament", camera: "bed", x: 0, y: 0, w: 0.5, h: 0.5 }, { name: "side", camera: "Side view", x: 0, y: 0, w: 1, h: 1 }],
      pictures: { count: 1, newest, recent: [newest], byCamera: { bed: newest } },
      server: { version: "0.1.0", readOnly: false, confirmMode: "auto", supervisor: "on", cameras: 2, pictureIntervalSeconds: 15, startedAt: 0 },
    });
    expect(s.crops[0]).toMatchObject({ name: "filament", file: "2026-10-12_17-43-07_bed.jpg", time: "2026-10-12 17:43:07" });
    expect(s.crops[1].file).toBeUndefined(); // no picture of that camera yet
    expect(s.server?.pictureIntervalSeconds).toBe(15);
    expect(s.queries).toEqual({ reads: [], tools: [], sinceT: 1 });
  });
  it("the page script draws views on a canvas and never writes HTML", () => {
    expect(COCKPIT_JS).toMatch(/drawImage/);
    expect(COCKPIT_JS).not.toMatch(/innerHTML|eval\(/);
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

describe("the cockpit through the running server (simulated Duet)", () => {
  const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");

  it("shows what was asked of the machine, what Claude called, the views and the server", async () => {
    const cam = createServer((_q, res) => res.writeHead(200, { "content-type": "image/jpeg" }).end(JPEG));
    await new Promise<void>((r) => cam.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(cam.address() as any).port}/s.jpg`;
    const port = await freePort();
    try {
      const { client, call } = await bootServer({ readOnly: true, env: {
        DUET_VIEWER_PORT: String(port), DUET_CAMERAS: `bed=${url}`, DUET_CAMERA_WIDTH: "0", DUET_IMAGE_DIR: join(mkdtempSync(join(tmpdir(), "pics-")), "p"),
        DUET_VIEW_CROPS: "filament=bed:0.1,0.1,0.3,0.3;broken=bed:2,2,2,2",
      } });
      await call("get_status");
      await call("get_status");
      await call("job_status");
      await client.callTool({ name: "get_camera_snapshot", arguments: { camera: "bed" } });
      const data: any = await until(async () => {
        const j: any = await (await fetch(`http://127.0.0.1:${port}/api/cockpit`)).json();
        return j.crops?.[0]?.file && j.queries.tools.length >= 3 && j.queries.reads.some((r: any) => r.source === "supervisor") ? j : undefined;
      }, 20000);

      const tools = Object.fromEntries(data.queries.tools.map((t: any) => [t.name, t.count]));
      expect(tools).toMatchObject({ get_status: 2, job_status: 1, get_camera_snapshot: 1 });
      const sources = data.queries.reads.map((r: any) => r.source);
      expect(sources).toContain("supervisor");
      expect(sources).toContain("assistant: get_status"); // the reads a tool made for the assistant
      expect(data.crops).toHaveLength(1); // the broken one was ignored at start
      expect(data.crops[0]).toMatchObject({ name: "filament", camera: "bed" });
      expect(data.crops[0].file).toMatch(/_bed\.jpg$/);
      expect(data.server).toMatchObject({ version: "0.1.0", readOnly: true, cameras: 1, pictureIntervalSeconds: 0 });
      expect(JSON.stringify(data.queries)).not.toMatch(/password/i);
    } finally { await new Promise<void>((r) => cam.close(() => r())); }
  }, 90000);
});
