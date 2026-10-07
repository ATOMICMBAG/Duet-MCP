import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "../src/crc32.js";
import { describeCompat, formatCompat } from "../src/compat.js";
import { DuetClient, DuetError } from "../src/duet.js";
import { startMockDuet } from "./helpers/mockDuet.js";
import { bootServer, closeAll } from "./helpers/bootServer.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await closeAll(); while (cleanups.length) await cleanups.pop()!(); });

const board = (name: string, shortName: string, firmwareVersion: string) => [{ name, shortName, firmwareVersion }];

describe("crc32", () => {
  it("matches the standard check value and handles empty input", () => {
    expect(crc32(new TextEncoder().encode("123456789")).toString(16)).toBe("cbf43926");
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("describeCompat", () => {
  it("knows the tested combination", () => {
    const c = describeCompat(board("Duet 2 WiFi", "2WiFi", "3.2.2"), { apiLevel: 1 });
    expect(c.support).toBe("tested");
    expect(c.summary).toMatch(/Duet 2 WiFi.*3\.2\.2.*tested/);
  });
  it("expects other Duet 2 boards and newer firmware to work but says it is untested", () => {
    expect(describeCompat(board("Duet 2 Ethernet", "2Ethernet", "3.2.2")).support).toBe("expected");
    expect(describeCompat(board("Duet 2 WiFi", "2WiFi", "3.5.4")).support).toBe("expected");
    expect(describeCompat(board("Duet 2 WiFi", "2WiFi", "3.4.6")).notes.join(" ")).toMatch(/Only a Duet 2 WiFi/);
  });
  it("expects Duet 3 in standalone mode to work and mentions the board computer limitation", () => {
    for (const [n, s] of [["Duet 3 Mini 5+", "Mini5plus"], ["Duet 3 MB6HC", "MB6HC"], ["Duet 3 MB6XD", "MB6XD"]]) {
      const c = describeCompat(board(n, s, "3.5.2"));
      expect(c.support).toBe("expected");
      expect(c.notes.join(" ")).toMatch(/standalone/);
    }
  });
  it("rejects firmware 2.x and the emulated single board computer mode", () => {
    expect(describeCompat(board("Duet 2 WiFi", "2WiFi", "2.05.1")).support).toBe("unsupported");
    const sbc = describeCompat(board("Duet 3 MB6HC", "MB6HC", "3.5.2"), { emulated: true });
    expect(sbc.support).toBe("unsupported");
    expect(sbc.notes.join(" ")).toMatch(/DuetWebServer/);
  });
  it("is honest when nothing can be read", () => {
    expect(describeCompat(undefined).support).toBe("unknown");
    expect(describeCompat([{ name: "x" }]).support).toBe("unknown");
    expect(formatCompat(describeCompat(undefined))).toMatch(/unknown/);
  });
});

async function client(initial: Parameters<typeof startMockDuet>[0] = {}, password = "") {
  const mock = await startMockDuet({ password, ...initial });
  cleanups.push(async () => { await mock.close(); });
  return { mock, make: () => new DuetClient(mock.host, password, { retries: 1, backoffMs: 5, timeoutMs: 2000 }) };
}

describe("session keys (newer firmware)", () => {
  it("sends the key with every request and reconnects when it expires", async () => {
    const { mock, make } = await client({ useSessionKeys: true });
    const c = make();
    expect(await c.model("state.status")).toBe("idle");
    expect(mock.state.keys.size).toBe(1);
    mock.expireSession();
    expect(await c.model("state.status")).toBe("idle");
    expect(mock.state.connects).toBe(2);
  });
  it("keeps two clients on the same IP apart (DWC in the browser and this server)", async () => {
    const { mock, make } = await client({ useSessionKeys: true });
    const a = make(), b = make();
    await a.model("state.status");
    await b.model("state.status");
    expect(mock.state.keys.size).toBe(2);
    await b.disconnect();
    expect(await a.model("state.status")).toBe("idle"); // a is not disturbed by b leaving
    expect(mock.state.keys.size).toBe(1);
  });
  it("still works on firmware without session keys", async () => {
    const { mock, make } = await client({ useSessionKeys: false });
    expect(await make().model("state.status")).toBe("idle");
    expect(mock.state.keys.size).toBe(0);
  });
});

describe("firmware without object model and emulated API", () => {
  it("refuses API level 0 with a clear message", async () => {
    const { make } = await client({ apiLevel: 0 });
    const err = await make().model("state.status").catch((e) => e);
    expect(err).toBeInstanceOf(DuetError);
    expect(err.kind).toBe("unsupported");
    expect(err.message).toMatch(/3\.x/);
  });
});

describe("upload with CRC32", () => {
  const file = (content: string) => { const dir = mkdtempSync(join(tmpdir(), "duet-mcp-crc-")); const p = join(dir, "t.gcode"); writeFileSync(p, content); return p; };
  it("sends the checksum and the Duet accepts it", async () => {
    const { mock, make } = await client();
    await make().upload(file("G28\nG1 X10\n"), "0:/gcodes/t.gcode");
    expect(mock.state.uploads["0:/gcodes/t.gcode"]).toBe(11);
    expect(mock.state.uploadAttempts).toBe(1);
  });
  it("repeats an upload whose checksum failed in transit", async () => {
    const { mock, make } = await client({ corruptUploads: 2 });
    await make().upload(file("G28\n"), "0:/gcodes/t.gcode");
    expect(mock.state.uploadAttempts).toBe(3);
    expect(mock.state.uploads["0:/gcodes/t.gcode"]).toBe(4);
  });
  it("gives up with a clear error after three failed transfers", async () => {
    const { mock, make } = await client({ corruptUploads: 10 });
    const err = await make().upload(file("G28\n"), "0:/gcodes/t.gcode").catch((e) => e);
    expect(err.kind).toBe("rejected");
    expect(err.message).toMatch(/after 3 attempts/);
    expect(mock.state.uploadAttempts).toBe(3);
  });
});

describe("get_machine_info and get_sensors (simulated Duet)", () => {
  it("reports board, firmware and verification status", async () => {
    const { call } = await bootServer({ readOnly: true });
    const r = await call("get_machine_info");
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Duet 2 WiFi.*3\.2\.2.*\[tested\]/);
    expect(r.text).toMatch(/API level 1/);
  }, 25000);
  it("warns once at startup when the firmware is outside the supported range", async () => {
    const { status, until } = await bootServer({ readOnly: true, initial: { boards: [{ name: "Duet 2 WiFi", shortName: "2WiFi", firmwareVersion: "3.2.2" }].map((b) => ({ ...b, firmwareVersion: "unknown" })) } });
    let s = "";
    await until(() => false, 1500);
    s = await status();
    expect(s).toMatch(/compatibility/);
  }, 25000);
  it("lists probes, filament monitors and analog sensors", async () => {
    const { call } = await bootServer({ readOnly: true, initial: { sensors: { endstops: [], probes: [{ type: 8, value: [1000] }], filamentMonitors: [{ type: "laser", status: "ok" }], analogSensors: [{ name: "mcu", lastReading: 31 }] } } });
    const r = await call("get_sensors");
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/laser/);
    expect(r.text).toMatch(/lastReading/);
  }, 25000);
});
