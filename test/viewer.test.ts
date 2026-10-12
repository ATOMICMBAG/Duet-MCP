import http from "node:http";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionFacts } from "../src/prompts.js";
import { archiveImage, discardFolder, imageSettings } from "../src/images.js";
import { startViewer, type Viewer } from "../src/viewer.js";
import { bootServer, closeAll } from "./helpers/bootServer.js";

afterEach(closeAll);

const tmp = () => mkdtempSync(join(tmpdir(), "view-"));
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function get(v: Viewer, path: string, opt: { method?: string; host?: string } = {}): Promise<{ status: number; body: Buffer; type: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: v.port, path, method: opt.method ?? "GET", headers: { host: opt.host ?? `127.0.0.1:${v.port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), type: String(res.headers["content-type"] ?? ""), headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("picture viewer", () => {
  it("settings: off unless a port from 1024 to 65535 is given", () => {
    expect(imageSettings({}).viewerPort).toBeUndefined();
    expect(imageSettings({ DUET_VIEWER_PORT: "8765" }).viewerPort).toBe(8765);
    expect(imageSettings({ DUET_VIEWER_PORT: "80" }).viewerPort).toBeUndefined();
    expect(imageSettings({ DUET_VIEWER_PORT: "abc" }).viewerPort).toBeUndefined();
  });

  it("serves the live page and the pictures, and nothing else", async () => {
    const dir = tmp();
    const a = archiveImage(dir, 200, { camera: "bed", data: JPEG, mimeType: "image/jpeg", layer: 3 }, new Date(2026, 9, 12, 17, 43, 7));
    writeFileSync(join(dir, "notes.txt"), "secret notes");
    const v = (await startViewer({ port: 0, getDir: () => dir, getNotes: () => ({ bed: "Overview" }), getStatus: () => "Machine: processing | layer 3 | tool 220/220 C" }))!;
    try {
      const page = await get(v, "/");
      expect(page.status).toBe(200);
      expect(page.type).toMatch(/text\/html/);
      const html = page.body.toString("utf8");
      expect(html).toMatch(/Machine: processing \| layer 3/);
      expect(html).toMatch(/<img src="img\/2026-10-12_17-43-07_bed_L3\.jpg"/);
      expect(html).not.toMatch(/data:image/); // the viewer serves the files, nothing is embedded
      expect(html).toMatch(/<meta http-equiv="refresh" content="5">/);
      expect(page.headers["cache-control"]).toBe("no-store");
      expect(String(page.headers["content-security-policy"])).toMatch(/default-src 'none'/);

      const img = await get(v, `/img/${a.file}`);
      expect(img.status).toBe(200);
      expect(img.type).toBe("image/jpeg");
      expect(img.body.equals(JPEG)).toBe(true);
      expect((await get(v, "/img/latest.jpg")).status).toBe(200);

      // nothing outside the picture files
      expect((await get(v, "/img/notes.txt")).status).toBe(404);
      expect((await get(v, "/img/..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
      expect((await get(v, "/img/%2e%2e/secret.jpg")).status).toBe(404);
      expect((await get(v, "/img/%E0%A4%A")).status).toBe(400);
      expect((await get(v, "/other")).status).toBe(404);
      expect((await get(v, "/", { method: "POST" })).status).toBe(405);
      expect((await get(v, "/", { method: "HEAD" })).body.length).toBe(0);
    } finally { await v.close(); }
  });

  it("refuses a Host header that is not the local address (DNS rebinding)", async () => {
    const dir = tmp();
    archiveImage(dir, 200, { camera: "bed", data: JPEG, mimeType: "image/jpeg" });
    const v = (await startViewer({ port: 0, getDir: () => dir, getNotes: () => ({}), getStatus: () => "" }))!;
    try {
      expect((await get(v, "/", { host: "evil.example.com" })).status).toBe(403);
      expect((await get(v, "/", { host: `evil.example.com:${v.port}` })).status).toBe(403);
      expect((await get(v, "/", { host: `localhost:${v.port}` })).status).toBe(200);
    } finally { await v.close(); }
  });

  it("listens on the loopback address only, and does not break when the port is taken", async () => {
    const dir = tmp();
    const v = (await startViewer({ port: 0, getDir: () => dir, getNotes: () => ({}), getStatus: () => "" }))!;
    try {
      const again = await startViewer({ port: v.port, getDir: () => dir, getNotes: () => ({}), getStatus: () => "" });
      expect(again).toBeUndefined();
      expect(v.url).toBe(`http://127.0.0.1:${v.port}/`);
    } finally { await v.close(); }
  });

  it("tells the assistant about the viewer", () => {
    expect(sessionFacts({ cameras: ["bed"], readOnly: true, viewerUrl: "http://127.0.0.1:8765/" })).toMatch(/Live picture viewer: http:\/\/127\.0\.0\.1:8765\//);
    expect(sessionFacts({ cameras: ["bed"], readOnly: true })).not.toMatch(/viewer/);
  });
});

describe("discardFolder", () => {
  it("deletes the server's own files only, and refuses a folder that is not a picture folder", () => {
    const base = tmp();
    const dir = join(base, "duet-mcp-images", "2026-10-12_17-43-07_job");
    archiveImage(dir, 200, { camera: "bed", data: JPEG, mimeType: "image/jpeg" });
    writeFileSync(join(dir, "my-notes.txt"), "keep me");
    const r = discardFolder(dir);
    expect(r).toMatchObject({ kept: 1, removedFolder: false });
    expect(r.deleted).toBeGreaterThanOrEqual(4); // picture, latest, index.html, .gitignore
    expect(readdirSync(dir)).toEqual(["my-notes.txt"]);

    const other = join(base, "important"); // a folder that is not a job folder is never touched, even if it holds files named like pictures
    mkdirSync(other);
    writeFileSync(join(other, "2026-10-12_17-43-07_bed.jpg"), "not ours to delete");
    expect(discardFolder(other)).toEqual({ deleted: 0, kept: 0, removedFolder: false });
    expect(existsSync(join(other, "2026-10-12_17-43-07_bed.jpg"))).toBe(true);
  });

  it("removes the folder when nothing else is in it", () => {
    const dir = join(tmp(), "duet-mcp-images", "2026-10-12_17-43-07_job");
    archiveImage(dir, 200, { camera: "bed", data: JPEG, mimeType: "image/jpeg" });
    expect(discardFolder(dir).removedFolder).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("one folder per print", () => {
  const camera = async () => {
    const srv = createServer((_q, res) => res.writeHead(200, { "content-type": "image/jpeg" }).end(JPEG));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${(srv.address() as any).port}/s.jpg`, close: () => new Promise<void>((r) => srv.close(() => r())) };
  };
  const pathOf = (r: any) => (r.content as any[]).filter((c) => c.type === "text").map((c) => c.text as string).join("\n").match(/Saved: (.+?\.jpg)/)![1];

  it("puts the pictures next to the G-code file that was uploaded, in a folder named after the job", async () => {
    const cam = await camera();
    const model = tmp();
    const gcode = join(model, "test.gcode");
    writeFileSync(gcode, "G28\n");
    const work = tmp();
    try {
      const { client, call, mock } = await bootServer({ readOnly: false, env: { DUET_CAMERAS: `bed=${cam.url}`, DUET_CAMERA_WIDTH: "0", DUET_IMAGE_DIR: join(work, "pics") } });
      expect((await call("upload_file", { localPath: gcode })).isError).toBe(false);
      const idle = pathOf(await client.callTool({ name: "get_camera_snapshot", arguments: {} }));
      expect(idle.startsWith(join(work, "pics"))).toBe(true); // before the job: the default folder

      mock.state.status = "processing"; // the job in the mock is 0:/gcodes/test.gcode, the file that was uploaded
      await sleep(1500);
      const during = pathOf(await client.callTool({ name: "get_camera_snapshot", arguments: {} }));
      expect(during.startsWith(join(model, "duet-mcp-images"))).toBe(true);
      expect(during).toMatch(/duet-mcp-images[\\/]\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_test[\\/]/);

      mock.state.status = "idle";
      await sleep(1500);
      const after = pathOf(await client.callTool({ name: "get_camera_snapshot", arguments: {} }));
      expect(after.startsWith(join(work, "pics"))).toBe(true); // idle again: back to the default folder
    } finally { await cam.close(); }
  }, 60000);

  it("uses a job folder below the default folder when the file was not uploaded here", async () => {
    const cam = await camera();
    const work = tmp();
    try {
      const { client, mock } = await bootServer({ readOnly: true, env: { DUET_CAMERAS: `bed=${cam.url}`, DUET_CAMERA_WIDTH: "0", DUET_IMAGE_DIR: join(work, "pics") } });
      mock.state.status = "processing";
      await sleep(1500);
      const p = pathOf(await client.callTool({ name: "get_camera_snapshot", arguments: {} }));
      expect(p).toMatch(/pics[\\/]\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_test[\\/]/);
    } finally { await cam.close(); }
  }, 60000);

  it("discard_job_images asks first, keeps the pictures when declined, and refuses while the job runs", async () => {
    const cam = await camera();
    const work = tmp();
    try {
      const keep = await bootServer({ readOnly: true, elicit: "decline", env: { DUET_CAMERAS: `bed=${cam.url}`, DUET_CAMERA_WIDTH: "0", DUET_IMAGE_DIR: join(work, "k") } });
      keep.mock.state.status = "processing";
      await sleep(1500);
      const p1 = pathOf(await keep.client.callTool({ name: "get_camera_snapshot", arguments: {} }));
      expect((await keep.call("discard_job_images")).text).toMatch(/still running/);
      keep.mock.state.status = "idle";
      await sleep(1500);
      const r1 = await keep.call("discard_job_images");
      expect(r1.isError).toBe(true);
      expect(r1.text).toMatch(/pictures are kept/);
      expect(existsSync(p1)).toBe(true);

      const go = await bootServer({ readOnly: true, env: { DUET_CAMERAS: `bed=${cam.url}`, DUET_CAMERA_WIDTH: "0", DUET_IMAGE_DIR: join(work, "g") } });
      go.mock.state.status = "processing";
      await sleep(1500);
      const p2 = pathOf(await go.client.callTool({ name: "get_camera_snapshot", arguments: {} }));
      go.mock.state.status = "idle";
      await sleep(1500);
      const r2 = await go.call("discard_job_images");
      expect(r2.isError).toBe(false);
      expect(r2.text).toMatch(/Deleted \d+ files/);
      expect(existsSync(p2)).toBe(false);
      expect(go.prompts.join("\n")).toMatch(/Delete \d+ camera pictures of the last print/);
    } finally { await cam.close(); }
  }, 90000);
});
