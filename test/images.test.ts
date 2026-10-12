import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyAudit } from "../src/audit.js";
import { archiveImage, imageSettings } from "../src/images.js";
import { bootServer, closeAll } from "./helpers/bootServer.js";

afterEach(closeAll);

const tmp = () => mkdtempSync(join(tmpdir(), "img-"));
const at = (s: number) => new Date(2026, 9, 12, 17, 43, s);
const jpg = (n: number) => Buffer.from([0xff, 0xd8, n, 0xff, 0xd9]);
const pics = (dir: string) => readdirSync(dir).filter((f) => /^\d{4}-/.test(f)).sort();

describe("imageSettings", () => {
  it("defaults to ./duet-mcp-images and 200 pictures, and can be switched off or tuned", () => {
    expect(imageSettings({}, "/work")).toMatchObject({ keep: 200 });
    expect(imageSettings({}, "/work").dir).toMatch(/duet-mcp-images$/);
    expect(imageSettings({ DUET_IMAGE_DIR: "off" }).dir).toBeUndefined();
    expect(imageSettings({ DUET_IMAGE_DIR: "None" }).dir).toBeUndefined();
    expect(imageSettings({ DUET_IMAGE_DIR: "pics", DUET_IMAGE_KEEP: "5" }, "/work")).toMatchObject({ keep: 5 });
    expect(imageSettings({ DUET_IMAGE_KEEP: "0" }).keep).toBe(200);
    expect(imageSettings({ DUET_IMAGE_KEEP: "abc" }).keep).toBe(200);
  });
});

describe("archiveImage", () => {
  it("names the file by time, camera and layer, and tells the hash", () => {
    const dir = tmp();
    const data = jpg(1);
    const a = archiveImage(dir, 200, { camera: "bed", data, mimeType: "image/jpeg", layer: 4 }, at(7));
    expect(a.file).toBe("2026-10-12_17-43-07_bed_L4.jpg");
    expect(readFileSync(a.path).equals(data)).toBe(true);
    expect(a.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    expect(readFileSync(join(dir, "latest.jpg")).equals(data)).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toMatch(/^\*$/m); // the folder ignores itself
    expect(existsSync(a.indexPath)).toBe(true);
  });

  it("cleans odd camera names and never overwrites a picture from the same second", () => {
    const dir = tmp();
    const a = archiveImage(dir, 200, { camera: "Bed / left?", data: jpg(1), mimeType: "image/png" }, at(1));
    const b = archiveImage(dir, 200, { camera: "Bed / left?", data: jpg(2), mimeType: "image/png" }, at(1));
    expect(a.file).toBe("2026-10-12_17-43-01_Bed-left.png");
    expect(b.file).toBe("2026-10-12_17-43-01_Bed-left-2.png");
    expect(pics(dir)).toHaveLength(2);
  });

  it("keeps only the newest N pictures and leaves foreign files alone", () => {
    const dir = tmp();
    writeFileSync(join(dir, "notes.txt"), "mine");
    writeFileSync(join(dir, "2020-01-01_holiday.jpg"), "not ours"); // does not match the naming scheme
    for (let s = 0; s < 6; s++) archiveImage(dir, 3, { camera: "bed", data: jpg(s), mimeType: "image/jpeg" }, at(s));
    expect(pics(dir).filter((f) => f.includes("_bed"))).toEqual(["2026-10-12_17-43-03_bed.jpg", "2026-10-12_17-43-04_bed.jpg", "2026-10-12_17-43-05_bed.jpg"]);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    expect(existsSync(join(dir, "2020-01-01_holiday.jpg"))).toBe(true);
  });

  it("writes an overview page with the newest picture first, escaped text, and no network references", () => {
    const dir = tmp();
    archiveImage(dir, 200, { camera: "bed", data: jpg(1), mimeType: "image/jpeg", layer: 2, notes: { bed: "Side <view> & \"close\"" } }, at(1));
    const a = archiveImage(dir, 200, { camera: "spool", data: jpg(2), mimeType: "image/jpeg", notes: { bed: "Side <view> & \"close\"" } }, at(9));
    const html = readFileSync(a.indexPath, "utf8");
    expect(html).toMatch(/<meta http-equiv="refresh" content="10">/);
    expect(html).toMatch(/2 pictures kept/);
    expect(html.indexOf("Latest")).toBeLessThan(html.indexOf("<figure>"));
    expect(html).toMatch(/Latest<\/b>: 2026-10-12 17:43:09 &middot; spool/);
    expect(html).toMatch(/<img src="data:image\/jpeg;base64,/); // the pictures are inside the page, no links to files next to it
    expect(html).not.toMatch(/(?:src|href)="[^d#][^"]*\.(jpg|png)"/);
    expect(html).toMatch(/layer 2/);
    expect(html).toMatch(/Side &lt;view&gt; &amp; &quot;close&quot;/);
    expect(html).not.toMatch(/Side <view>/);
    expect(html).not.toMatch(/https?:\/\//);
  });
});

describe("older pictures", () => {
  it("embeds the newest 13 and lists the rest by name", () => {
    const dir = tmp();
    for (let s = 0; s < 16; s++) archiveImage(dir, 200, { camera: "bed", data: jpg(s), mimeType: "image/jpeg" }, at(s));
    const html = readFileSync(join(dir, "index.html"), "utf8");
    expect(html.match(/data:image\/jpeg;base64,/g)).toHaveLength(13);
    expect(html).toMatch(/3 older pictures are in the folder/);
    expect(html).toMatch(/2026-10-12_17-43-02_bed\.jpg/);
  });
});

describe("the snapshot tool archives what it hands to the assistant", () => {
  const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");

  it("saves each picture, links it in the audit log with its hash, and keeps 3", async () => {
    const srv = createServer((_q, res) => res.writeHead(200, { "content-type": "image/jpeg" }).end(JPEG));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as any).port}/s.jpg`;
    const dir = join(tmp(), "pics");
    try {
      const { client, auditFile } = await bootServer({ readOnly: true, env: { DUET_CAMERAS: `bed=${url}`, DUET_CAMERA_WIDTH: "0", DUET_IMAGE_DIR: dir, DUET_IMAGE_KEEP: "3" } });
      let first = "";
      for (let i = 0; i < 5; i++) {
        const r = await client.callTool({ name: "get_camera_snapshot", arguments: { camera: "bed" } });
        const text = ((r.content as any[]).find((c) => c.type === "text").text as string);
        expect(text).toMatch(/Saved: .*_bed\.jpg|Saved: .*_bed-\d\.jpg/);
        if (i === 0) { first = text; expect(text).toMatch(/Overview page with the latest pictures: .*index\.html/); }
        else expect(text).not.toMatch(/Overview page/); // said once per session
        await new Promise((r2) => setTimeout(r2, 1100)); // names have a resolution of one second
      }
      expect(pics(dir)).toHaveLength(3);
      expect(existsSync(join(dir, "index.html"))).toBe(true);
      const log = readFileSync(auditFile, "utf8");
      const lines = log.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.tool === "camera-image");
      expect(lines).toHaveLength(5);
      expect(lines[0].sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(verifyAudit(log).ok).toBe(true);
      expect(first).toMatch(/Saved:/);
      // the newest saved picture is the one the log names last
      const last = lines.at(-1);
      expect(pics(dir)).toContain(last.file);
    } finally { await new Promise<void>((r) => srv.close(() => r())); }
  }, 60000);

  it("saves nothing when switched off", async () => {
    const srv = createServer((_q, res) => res.writeHead(200, { "content-type": "image/jpeg" }).end(JPEG));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as any).port}/s.jpg`;
    try {
      const { client } = await bootServer({ readOnly: true, env: { DUET_CAMERAS: `bed=${url}`, DUET_CAMERA_WIDTH: "0", DUET_IMAGE_DIR: "off" } });
      const r = await client.callTool({ name: "get_camera_snapshot", arguments: { camera: "bed" } });
      expect(JSON.stringify(r.content.filter((c: any) => c.type === "text"))).not.toMatch(/Saved/);
    } finally { await new Promise<void>((r) => srv.close(() => r())); }
  }, 30000);
});

describe("periodic pictures", () => {
  it("settings: off by default, never faster than every 5 s", () => {
    expect(imageSettings({}).intervalSeconds).toBe(0);
    expect(imageSettings({ DUET_IMAGE_INTERVAL_SECONDS: "60" }).intervalSeconds).toBe(60);
    expect(imageSettings({ DUET_IMAGE_INTERVAL_SECONDS: "1" }).intervalSeconds).toBe(5);
    expect(imageSettings({ DUET_IMAGE_INTERVAL_SECONDS: "x" }).intervalSeconds).toBe(0);
    expect(imageSettings({}).autoKeep).toBe(300);
    expect(imageSettings({ DUET_IMAGE_AUTO_KEEP: "10" }).autoKeep).toBe(10);
  });

  it("auto pictures are marked, and kept apart from the ones the assistant saw", () => {
    const dir = tmp();
    archiveImage(dir, 2, { camera: "bed", data: jpg(1), mimeType: "image/jpeg" }, at(0), 3); // analysed
    for (let s = 1; s <= 6; s++) archiveImage(dir, 2, { camera: "bed", data: jpg(s), mimeType: "image/jpeg", auto: true, layer: 3 }, at(s), 3);
    const files = pics(dir);
    expect(files.filter((f) => f.includes("_auto"))).toHaveLength(3); // only the newest 3 periodic pictures
    expect(files).toContain("2026-10-12_17-43-00_bed.jpg"); // the analysed one survives the periodic flood
    expect(files).toContain("2026-10-12_17-43-06_bed_L3_auto.jpg");
    expect(readFileSync(join(dir, "index.html"), "utf8")).toMatch(/layer 3 &middot; auto/);
  });

  it("takes pictures while a job is active and one more when it ends, none while idle, and links them in the audit log", async () => {
    const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
    const srv = createServer((_q, res) => res.writeHead(200, { "content-type": "image/jpeg" }).end(JPEG));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as any).port}/s.jpg`;
    const dir = join(tmp(), "pics");
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      const { mock, auditFile } = await bootServer({ readOnly: true, initial: { status: "processing" }, env: { DUET_CAMERAS: `bed=${url}`, DUET_CAMERA_WIDTH: "0", DUET_IMAGE_DIR: dir, DUET_IMAGE_INTERVAL_SECONDS: "5" } });
      await sleep(7000);
      const during = pics(dir).filter((f) => f.includes("_auto")).length;
      expect(during).toBeGreaterThanOrEqual(1);
      mock.state.status = "idle";
      await sleep(6000);
      const after = pics(dir).filter((f) => f.includes("_auto")).length;
      expect(after).toBe(during + 1); // one last picture of the finished part
      await sleep(5500);
      expect(pics(dir).filter((f) => f.includes("_auto")).length).toBe(after); // nothing while idle
      const log = readFileSync(auditFile, "utf8");
      expect(log.split("\n").filter((l) => l.includes('"camera-image"') && l.includes('"auto":true'))).toHaveLength(after);
      expect(verifyAudit(log).ok).toBe(true);
    } finally { await new Promise<void>((r) => srv.close(() => r())); }
  }, 60000);
});
