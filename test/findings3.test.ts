import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { INSTRUCTIONS, PROMPTS } from "../src/prompts.js";
import { bootServer, closeAll } from "./helpers/bootServer.js";

afterEach(closeAll);

// A tiny valid JPEG, so the camera tool succeeds without ffmpeg.
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");

async function camera() {
  const srv = createServer((_req, res) => res.writeHead(200, { "content-type": "image/jpeg" }).end(JPEG));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(srv.address() as any).port}/shot.jpg`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

describe("A: the start approval says whether the bed was looked at", () => {
  it("warns when a camera exists but no picture was taken, and notes it when one was", async () => {
    const cam = await camera();
    try {
      const { call, prompts } = await bootServer({ readOnly: false, env: { DUET_CAMERAS: `bed=${cam.url}`, DUET_CAMERA_WIDTH: "0" } });
      expect((await call("start_job", { file: "t.gcode" })).isError).toBe(false);
      expect(prompts.at(-1)).toMatch(/NO picture of the bed was taken in the last 10 minutes/);
      await call("get_camera_snapshot", { camera: "bed" });
      await call("start_job", { file: "t.gcode" }).catch(() => undefined);
      expect(prompts.at(-1)).toMatch(/Camera: a picture was taken 0 min ago/);
    } finally { await cam.close(); }
  }, 60000);

  it("says nothing about cameras when none is configured", async () => {
    const { call, prompts } = await bootServer({ readOnly: false });
    await call("start_job", { file: "t.gcode" });
    expect(prompts.at(-1)).not.toMatch(/Camera:/);
  }, 30000);
});

describe("B: the instructions say what the assistant cannot do", () => {
  it("tells it to look at the bed first, not to promise background polling, and to ask before resuming", () => {
    expect(INSTRUCTIONS).toMatch(/Before start_job, if a camera is configured: get_camera_snapshot/);
    expect(INSTRUCTIONS).toMatch(/cannot watch the machine between your answers/);
    expect(INSTRUCTIONS).toMatch(/Never promise to keep polling/);
    expect(INSTRUCTIONS).toMatch(/Ask the user before resume_job/);
    expect(INSTRUCTIONS).not.toMatch(/poll job_status every few minutes/);
    const supervised = PROMPTS.find((p) => p.name === "start_print_supervised")!.build({ file: "a.gcode" });
    expect(supervised).toMatch(/you cannot watch in the background/);
    expect(supervised).not.toMatch(/every few minutes/);
  });
});

describe("C: tolerant parameter names", () => {
  it("list_files and read_file accept dir/path and name/path", async () => {
    const { call } = await bootServer({ readOnly: true, initial: { files: { "0:/sys": [{ name: "config.g", size: 10, type: "f", date: "2026-01-01T00:00:00" }], "0:/gcodes": [] } } });
    expect((await call("list_files", { path: "0:/sys" })).text).toMatch(/config\.g/);
    expect((await call("list_files", { dir: "0:/sys" })).text).toMatch(/config\.g/);
    expect((await call("list_files", {})).text).not.toMatch(/config\.g/); // default stays 0:/gcodes
    const noName = await call("read_file", {});
    expect(noName.isError).toBe(true);
    expect(noName.text).toMatch(/name, for example 0:\/sys\/config\.g/);
    expect((await call("read_file", { path: "0:/sys/config.g" })).text).toMatch(/M208 X220/);
    expect((await call("read_file", { name: "0:/sys/config.g" })).text).toMatch(/M208 X220/);
  }, 30000);
});
