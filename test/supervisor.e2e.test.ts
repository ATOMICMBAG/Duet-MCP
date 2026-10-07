import { afterEach, describe, expect, it } from "vitest";
import { startMockDuet } from "./helpers/mockDuet.js";
import { bootServer, closeAll } from "./helpers/bootServer.js";

afterEach(closeAll);

const boot = (readOnly: boolean, initial?: Parameters<typeof startMockDuet>[0], extraEnv: Record<string, string> = {}) =>
  bootServer({ readOnly, initial, env: extraEnv, elicit: "accept" });

const printing = () => ({
  status: "processing",
  heaters: [{ current: 55, active: 55, standby: 0, state: "active" }, { current: 220, active: 220, standby: 0, state: "active" }],
});

describe("supervisor inside the server (simulated Duet)", () => {
  it("pauses the job when the nozzle drifts away (control enabled)", async () => {
    const { mock, until, status } = await boot(false, printing());
    await new Promise((r) => setTimeout(r, 800)); // settled, job started
    mock.state.heaters[1].current = 180;
    expect(await until(() => mock.state.gcodes.includes("M25"))).toBe(true);
    expect(mock.state.status).toBe("paused");
    const s = await status();
    expect(s).toMatch(/temperature-deviation/);
    expect(s).toMatch(/ACTIVE/);
  }, 20000);

  it("only reports in read-only mode and never sends a command", async () => {
    const { mock, status } = await boot(true, printing());
    await new Promise((r) => setTimeout(r, 800));
    mock.state.heaters[1].current = 180;
    await new Promise((r) => setTimeout(r, 2500));
    const s = await status();
    expect(s).toMatch(/temperature-deviation/);
    expect(s).toMatch(/action-skipped/);
    expect(s).toMatch(/observe only/);
    expect(mock.state.gcodes).toEqual([]);
  }, 20000);

  it("switches heaters off and pauses on over-temperature", async () => {
    const { mock, until } = await boot(false, printing());
    await new Promise((r) => setTimeout(r, 600));
    mock.state.heaters[1].current = 290;
    expect(await until(() => mock.state.gcodes.includes("M25"))).toBe(true);
    expect(mock.state.gcodes).toEqual(expect.arrayContaining(["M104 T0 S0", "M140 S0", "M25"]));
  }, 20000);

  it("applies the speed profile at the layer steps and resets it when the job ends", async () => {
    const { mock, until, status } = await boot(false, { ...printing(), job: { layer: 1, filePosition: 100, file: { size: 1000, fileName: "0:/gcodes/t.gcode" } } }, { DUET_SPEED_PROFILE: "1:30,2:50,3:80" });
    expect(await until(() => mock.state.gcodes.includes("M220 S30"))).toBe(true);
    mock.state.job.layer = 2;
    expect(await until(() => mock.state.gcodes.includes("M220 S50"))).toBe(true);
    mock.state.job.layer = 3; mock.state.job.filePosition = 300;
    expect(await until(() => mock.state.gcodes.includes("M220 S80"))).toBe(true);
    expect(await status()).toMatch(/Speed: factor 80 %/);
    mock.state.status = "idle";
    expect(await until(() => mock.state.gcodes.includes("M220 S100"))).toBe(true);
    expect(mock.state.gcodes.filter((g) => g.startsWith("M220"))).toEqual(["M220 S30", "M220 S50", "M220 S80", "M220 S100"]);
  }, 25000);

  it("sends the first speed step before the job starts", async () => {
    const { mock, client } = await boot(false, {}, { DUET_SPEED_PROFILE: "1:30,2:50" });
    const r = await client.callTool({ name: "start_job", arguments: { file: "t.gcode" } });
    expect(r.isError).toBeFalsy();
    expect(mock.state.gcodes.slice(0, 2)).toEqual(["M220 S30", 'M32 "0:/gcodes/t.gcode"']);
    expect((r.content as any[])[0].text).toMatch(/speed 30 % from layer 1/);
  }, 25000);

  it("sets a profile through the tool while a job is running and rejects bad input", async () => {
    const { mock, client, until } = await boot(false, { ...printing(), job: { layer: 4, filePosition: 400, file: { size: 1000, fileName: "0:/gcodes/t.gcode" } } });
    const bad = await client.callTool({ name: "set_speed_profile", arguments: { profile: "1:5" } });
    expect(bad.isError).toBe(true);
    const ok = await client.callTool({ name: "set_speed_profile", arguments: { profile: "1:30,3:70" } });
    expect((ok.content as any[])[0].text).toMatch(/from layer 3: 70 %/);
    expect(await until(() => mock.state.gcodes.includes("M220 S70"))).toBe(true);
  }, 25000);

  it("never sends M220 in read-only mode, it only reports", async () => {
    const { mock, status } = await boot(true, { ...printing(), job: { layer: 1, filePosition: 100, file: { size: 1000, fileName: "0:/gcodes/t.gcode" } } }, { DUET_SPEED_PROFILE: "1:30" });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await status()).toMatch(/speed-skipped/);
    expect(mock.state.gcodes).toEqual([]);
  }, 25000);

  it("survives an expired session without any event or error", async () => {
    const { mock, status } = await boot(false, printing());
    await new Promise((r) => setTimeout(r, 700));
    mock.expireSession();
    await new Promise((r) => setTimeout(r, 900));
    const s = await status();
    expect(s).not.toMatch(/connection-lost|auth-failed/);
    expect(s).toMatch(/Status: processing/);
  }, 25000);

  it("explains a rejected password in job_status and reports the recovery", async () => {
    const { mock, client } = await boot(true, printing());
    await new Promise((r) => setTimeout(r, 700));
    mock.state.password = "changed"; mock.expireSession();
    await new Promise((r) => setTimeout(r, 1200));
    const r = await client.callTool({ name: "job_status", arguments: { events: 10 } });
    const text = (r.content as any[])[0].text as string;
    expect(r.isError).toBe(true);
    expect(text).toMatch(/CANNOT READ THE DUET/);
    expect(text).toMatch(/rejected the password/);
    expect(text).toMatch(/auth-failed/);
    mock.state.password = "";
    await new Promise((r2) => setTimeout(r2, 1500));
    const ok = await client.callTool({ name: "job_status", arguments: { events: 10 } });
    expect((ok.content as any[])[0].text).toMatch(/connection-restored/);
  }, 25000);

  it("reports a board restart and the lost job", async () => {
    const { mock, status } = await boot(true, { ...printing(), upTime: 5000, job: { layer: 3, filePosition: 400, file: { size: 1000, fileName: "0:/gcodes/t.gcode" } } });
    await new Promise((r) => setTimeout(r, 800));
    mock.state.status = "idle"; mock.state.upTime = 6; mock.state.heaters[1].active = 0;
    await new Promise((r) => setTimeout(r, 900));
    const s = await status();
    expect(s).toMatch(/duet-restarted/);
    expect(s).not.toMatch(/job-ended-early/);
  }, 25000);

  it("stays quiet for a healthy idle machine", async () => {
    const { mock, status } = await boot(false);
    await new Promise((r) => setTimeout(r, 1200));
    expect(await status()).toMatch(/No events yet/);
    expect(mock.state.gcodes).toEqual([]);
  }, 20000);
});
