import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatLocalCameras, parseDshowDevices } from "../src/camera.js";
import { remotePath } from "../src/paths.js";
import { bootServer, closeAll } from "./helpers/bootServer.js";

afterEach(closeAll);

describe("remotePath", () => {
  it("sends bare names to 0:/gcodes (the bug a fresh assistant ran into)", () => {
    expect(remotePath(undefined, "cube.gcode")).toBe("0:/gcodes/cube.gcode");
    expect(remotePath("cube.gcode", "x")).toBe("0:/gcodes/cube.gcode");
    expect(remotePath("  ", "cube.gcode")).toBe("0:/gcodes/cube.gcode");
  });
  it("keeps full paths and maps folders to the first drive", () => {
    expect(remotePath("0:/macros/x.g", "x")).toBe("0:/macros/x.g");
    expect(remotePath("1:/gcodes/a.gcode", "x")).toBe("1:/gcodes/a.gcode");
    expect(remotePath("/macros/x.g", "x")).toBe("0:/macros/x.g");
    expect(remotePath("macros/x.g", "x")).toBe("0:/macros/x.g");
    expect(remotePath("gcodes\\a.gcode", "x")).toBe("0:/gcodes/a.gcode");
  });
  it("still blocks 0:/sys after normalising", async () => {
    const dir = mkdtempSync(join(tmpdir(), "up-"));
    const f = join(dir, "a.g");
    writeFileSync(f, "G28\n");
    const { call, mock } = await bootServer({ readOnly: false });
    expect((await call("upload_file", { localPath: f, remoteName: "/sys/config.g" })).isError).toBe(true);
    expect((await call("upload_file", { localPath: f, remoteName: "sys/config.g" })).isError).toBe(true);
    const ok = await call("upload_file", { localPath: f, remoteName: "a.g" });
    expect(ok.text).toBe("Uploaded to 0:/gcodes/a.g");
    expect(Object.keys(mock.state.uploads)).toEqual(["0:/gcodes/a.g"]);
  }, 30000);
});

describe("local camera listing", () => {
  const listing = '[in#0 @ 000001da0a7838c0] "Integrated Camera" (video)\n[in#0 @ 000001da0a7838c0] "USB Camera" (video)\n[in#0] "Mic" (audio)';
  it("finds the video devices only", () => {
    expect(parseDshowDevices(listing)).toEqual(["Integrated Camera", "USB Camera"]);
  });
  it("tells the user the exact setting to add", () => {
    const t = formatLocalCameras(listing);
    expect(t).toContain('DUET_CAMERAS="cam=dshow:Integrated Camera,cam2=dshow:USB Camera"');
    expect(t).toMatch(/\.env/);
  });
  it("explains what to do when there is no device", () => {
    expect(formatLocalCameras("ffmpeg not usable: spawn ffmpeg ENOENT")).toMatch(/rtsp|http/);
  });
});
