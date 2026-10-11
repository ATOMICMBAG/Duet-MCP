import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { brightnessLabel, parseCameraNotes, processFrame, sourceKind } from "../src/camera.js";
import { bootServer, closeAll } from "./helpers/bootServer.js";

afterEach(closeAll);

const hasFfmpeg = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"]).status === 0;
const jpeg = (color: string, size = "640x480") => spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=${size}`, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"]).stdout as Buffer;

async function cameraServer(pics: Record<string, Buffer>) {
  const srv = createServer((req, res) => {
    const pic = pics[req.url ?? ""];
    if (!pic) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "image/jpeg" }).end(pic);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port as number;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

describe("camera helpers", () => {
  it("reads camera notes", () => {
    expect(parseCameraNotes({ DUET_CAMERA_NOTES: "side=Side view at bed height, nozzle contact; spool = Spool close-up ;broken;x=" })).toEqual({
      side: "Side view at bed height, nozzle contact", spool: "Spool close-up",
    });
    expect(parseCameraNotes({})).toEqual({});
  });
  it("names the kind of source without showing the address", () => {
    expect(sourceKind("rtsp://user:pw@10.0.0.2/s")).toBe("RTSP stream");
    expect(sourceKind("dshow:Integrated Camera")).toMatch(/webcam/);
    expect(sourceKind("http://user:pw@10.0.0.3/shot.jpg")).not.toMatch(/pw|10\.0/);
  });
  it("labels brightness", () => {
    expect([brightnessLabel(5), brightnessLabel(120), brightnessLabel(250)]).toEqual(["dark", "ok", "bright"]);
  });
  it.skipIf(!hasFfmpeg)("shrinks pictures and measures brightness", async () => {
    const big = jpeg("gray", "1280x720");
    const p = await processFrame({ data: big, mimeType: "image/jpeg" }, 320);
    expect(p.data.length).toBeLessThan(big.length);
    expect(brightnessLabel(p.brightness!)).toBe("ok");
    expect(brightnessLabel((await processFrame({ data: jpeg("black"), mimeType: "image/jpeg" }, 0)).brightness!)).toBe("dark");
  }, 30000);
  it("keeps the original and says so when ffmpeg is missing", async () => {
    const old = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = "definitely-not-ffmpeg";
    try {
      const p = await processFrame({ data: Buffer.from([1, 2, 3]), mimeType: "image/jpeg" }, 320);
      expect(p.data).toEqual(Buffer.from([1, 2, 3]));
      expect(p.note).toMatch(/ffmpeg/);
    } finally { if (old === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = old; }
  });
});

describe("camera tools (simulated cameras)", () => {
  it("lists cameras with notes, and hides addresses", async () => {
    const { call } = await bootServer({ readOnly: true, env: {
      DUET_CAMERAS: "side=http://user:secret@127.0.0.1:9/a.jpg,spool=http://127.0.0.1:9/b.jpg",
      DUET_CAMERA_NOTES: "side=Side view at bed height;spool=Spool close-up",
    } });
    const r = await call("list_cameras");
    expect(r.text).toMatch(/side \(HTTP snapshot \/ MJPEG\): Side view at bed height/);
    expect(r.text).toMatch(/spool .*Spool close-up/);
    expect(r.text).not.toMatch(/secret|127\.0\.0\.1/);
  }, 25000);

  it("returns several labelled pictures in one call and reports failures per camera", async () => {
    const cams = await cameraServer({ "/a.jpg": hasFfmpeg ? jpeg("gray") : Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "/dark.jpg": hasFfmpeg ? jpeg("black") : Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    try {
      const { client, call } = await bootServer({ readOnly: true, env: {
        DUET_CAMERAS: `side=${cams.base}/a.jpg,dark=${cams.base}/dark.jpg,gone=${cams.base}/missing.jpg`,
        DUET_CAMERA_NOTES: "side=Side view at bed height",
      } });
      const r = await client.callTool({ name: "get_camera_snapshot", arguments: { cameras: ["side", "dark", "gone"] } });
      const c = r.content as any[];
      expect(c.filter((x) => x.type === "image")).toHaveLength(2);
      const texts = c.filter((x) => x.type === "text").map((x) => x.text as string);
      expect(texts[0]).toMatch(/side .*Side view at bed height/);
      expect(texts.some((t) => /gone.*failed/.test(t))).toBe(true);
      if (hasFfmpeg) expect(texts.some((t) => /dark.*Too dark/.test(t))).toBe(true);
      expect(r.isError).toBeFalsy();
      const all = await client.callTool({ name: "get_camera_snapshot", arguments: { camera: "nope" } });
      expect(all.isError).toBe(true);
      expect(((all.content as any[])[0].text as string)).toMatch(/Unknown camera.*Available: side, dark, gone/);
      expect((await call("get_camera_snapshot", { camera: "gone" })).isError).toBe(true);
    } finally { await cams.close(); }
  }, 60000);
});
