import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuetClient, DuetError } from "../src/duet.js";
import { startMockDuet } from "./helpers/mockDuet.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function setup(password = "", clientPassword = password, initial: Parameters<typeof startMockDuet>[0] = {}) {
  const mock = await startMockDuet({ password, ...initial });
  const client = new DuetClient(mock.host, clientPassword, { retries: 3, backoffMs: 5, timeoutMs: 2000 });
  cleanups.push(async () => { await mock.close(); });
  return { mock, client };
}
const kindOf = async (p: Promise<unknown>) => { try { await p; return "no error"; } catch (e) { return e instanceof DuetError ? e.kind : `other: ${(e as Error).message}`; } };

describe("DuetClient files", () => {
  it("lists a directory across several answers (the firmware pages long listings)", async () => {
    const files = ["a", "b", "c", "d", "e"].map((n) => ({ name: `${n}.gcode`, size: 10, type: "f" as const, date: "2026-10-07T10:00:00" }));
    const { client } = await setup("", "", { files: { "0:/gcodes": files }, pageSize: 2 });
    expect((await client.list("0:/gcodes")).map((f) => f.name)).toEqual(["a.gcode", "b.gcode", "c.gcode", "d.gcode", "e.gcode"]);
    expect(await client.list("0:/empty")).toEqual([]);
  });

  it("uploads a local file and reports a refused upload", async () => {
    const { mock, client } = await setup();
    const dir = mkdtempSync(join(tmpdir(), "duet-mcp-up-"));
    const local = join(dir, "t.gcode");
    writeFileSync(local, "G28\nG1 X10\n");
    await client.upload(local, "0:/gcodes/t.gcode");
    expect(mock.state.uploads["0:/gcodes/t.gcode"]).toBe(11);
    mock.state.uploadErr = 1;
    expect(await kindOf(client.upload(local, "0:/gcodes/t2.gcode"))).toBe("rejected");
  });

  it("downloads a text file", async () => {
    const { client } = await setup();
    expect(await client.download("0:/sys/config.g")).toMatch(/M208 X220/);
  });
});

describe("DuetClient reconnect rules", () => {
  it("reconnects transparently after the session expired, for reads", async () => {
    const { mock, client } = await setup();
    expect(await client.model("state.status")).toBe("idle");
    mock.expireSession();
    expect(await client.model("state.status")).toBe("idle");
    expect(mock.state.connects).toBe(2);
  });

  it("reconnects after an expired session and runs a command exactly once", async () => {
    const { mock, client } = await setup();
    await client.model("state.status");
    mock.expireSession();
    await client.gcode("M105");
    expect(mock.state.gcodes).toEqual(["M105"]);
  });

  it("reports a wrong password at once with a clear message and does not hammer the board", async () => {
    const { mock, client } = await setup("secret", "wrong");
    const err = await client.model("state.status").catch((e) => e);
    expect(err).toBeInstanceOf(DuetError);
    expect(err.kind).toBe("auth");
    expect(err.message).toMatch(/DUET_PASSWORD/);
    expect(mock.state.connects).toBe(0);
  });

  it("recovers when the password is fixed on the board side after a change", async () => {
    const { mock, client } = await setup("");
    await client.model("state.status");
    mock.state.password = "new"; mock.expireSession(); // e.g. the board restarted and loaded a password from config.g
    expect(await kindOf(client.model("state.status"))).toBe("auth");
    mock.state.password = "";
    expect(await client.model("state.status")).toBe("idle");
  });

  it("retries reads while the Duet has no free session", async () => {
    const { mock, client } = await setup("", "", { noSessions: true });
    setTimeout(() => { mock.state.noSessions = false; }, 12);
    expect(await client.model("state.status")).toBe("idle");
  });

  it("says no free session when it stays busy", async () => {
    const { client } = await setup("", "", { noSessions: true });
    const err = await client.model("state.status").catch((e) => e);
    expect(err.kind).toBe("busy");
    expect(err.message).toMatch(/Close other DWC/);
  });

  it("reports an unreachable Duet with the host in the message", async () => {
    const { mock, client } = await setup();
    await client.model("state.status");
    await mock.close();
    const err = await client.model("state.status").catch((e) => e);
    expect(err.kind).toBe("unreachable");
    expect(err.message).toContain(mock.host);
  });

  it("never repeats a command after the connection failed (it may have run)", async () => {
    const { mock, client } = await setup();
    await client.model("state.status");
    await mock.close();
    expect(await kindOf(client.gcode("M104 S200"))).toBe("unreachable");
  });

  it("keeps the session when the Duet rejects a command", async () => {
    const { mock, client } = await setup();
    await client.model("state.status");
    mock.state.nextGcodeReply = "Error: M0: Pause the print before attempting to cancel it";
    expect(await kindOf(client.gcode("M0"))).toBe("rejected");
    await client.model("state.status");
    expect(mock.state.connects).toBe(1);
  });
});
