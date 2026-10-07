import { afterEach, describe, expect, it } from "vitest";
import { bootServer, closeAll } from "./helpers/bootServer.js";

afterEach(closeAll);

describe("confirmation inside the server (simulated Duet and client)", () => {
  it("send_gcode: asks the user, shows the code and the reason, and sends only after approval", async () => {
    const { mock, call, prompts } = await bootServer({ readOnly: false, elicit: "accept" });
    const r = await call("send_gcode", { gcode: "M104 S200" });
    expect(r.isError).toBe(false);
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toMatch(/M104 S200/);
    expect(prompts[0]).toMatch(/heating/);
    expect(mock.state.gcodes).toEqual(["M104 S200"]);
  }, 25000);

  it("send_gcode: a declined question sends nothing", async () => {
    const { mock, call } = await bootServer({ readOnly: false, elicit: "decline" });
    const r = await call("send_gcode", { gcode: "M104 S200" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Not approved \(elicitation\)/);
    expect(mock.state.gcodes).toEqual([]);
  }, 25000);

  it("send_gcode: the model cannot approve for the user (confirm=true is ignored)", async () => {
    const { mock, call, prompts } = await bootServer({ readOnly: false, elicit: "decline" });
    const r = await call("send_gcode", { gcode: "M104 S200", confirm: true });
    expect(r.isError).toBe(true);
    expect(prompts.length).toBe(1); // it asked anyway
    expect(mock.state.gcodes).toEqual([]);
  }, 25000);

  it("send_gcode: harmless commands need no question", async () => {
    const { mock, call, prompts } = await bootServer({ readOnly: false, elicit: "decline" });
    const r = await call("send_gcode", { gcode: "M105" });
    expect(r.isError).toBe(false);
    expect(prompts).toEqual([]);
    expect(mock.state.gcodes).toEqual(["M105"]);
  }, 25000);

  it("send_gcode: hard blocks stay blocked even if the user would approve", async () => {
    const { mock, call, prompts } = await bootServer({ readOnly: false, elicit: "accept" });
    const r = await call("send_gcode", { gcode: "M104 S200\nM997" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/M997 is blocked/);
    expect(prompts).toEqual([]);
    expect(mock.state.gcodes).toEqual([]);
  }, 25000);

  it("a client without elicitation and without a system dialog gets a refusal that explains the options", async () => {
    const { mock, call } = await bootServer({ readOnly: false, elicit: "none" });
    const r = await call("send_gcode", { gcode: "M104 S200" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no way to ask the user/);
    expect(mock.state.gcodes).toEqual([]);
  }, 25000);

  it("DUET_CONFIRM=model trusts the confirm flag (documented as unsafe)", async () => {
    const { mock, call } = await bootServer({ readOnly: false, elicit: "none", env: { DUET_CONFIRM: "model" } });
    expect((await call("send_gcode", { gcode: "M104 S200" })).isError).toBe(true);
    expect((await call("send_gcode", { gcode: "M104 S200", confirm: true })).isError).toBe(false);
    expect(mock.state.gcodes).toEqual(["M104 S200"]);
  }, 25000);

  it("DUET_CONFIRM=deny switches the gated actions off", async () => {
    const { mock, call } = await bootServer({ readOnly: false, elicit: "accept", env: { DUET_CONFIRM: "deny" } });
    expect((await call("send_gcode", { gcode: "M104 S200" })).isError).toBe(true);
    expect(mock.state.gcodes).toEqual([]);
  }, 25000);

  it("start_job: always asks, and starts only after approval", async () => {
    const dec = await bootServer({ readOnly: false, elicit: "decline" });
    const r1 = await dec.call("start_job", { file: "t.gcode" });
    expect(r1.isError).toBe(true);
    expect(r1.text).toMatch(/print was not started/);
    expect(dec.mock.state.gcodes).toEqual([]);
    const acc = await bootServer({ readOnly: false, elicit: "accept" });
    const r2 = await acc.call("start_job", { file: "t.gcode" });
    expect(r2.isError).toBe(false);
    expect(acc.prompts[0]).toMatch(/t\.gcode/);
    expect(acc.prompts[0]).toMatch(/bed clear/);
    expect(acc.mock.state.gcodes).toEqual(['M32 "0:/gcodes/t.gcode"']);
  }, 30000);

  it("home_axes: asks once and the machine does not move when declined", async () => {
    const { mock, call, prompts } = await bootServer({ readOnly: false, elicit: "decline" });
    const r = await call("home_axes", { axes: "" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/did not move/);
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toMatch(/Z, X, Y/);
    expect(mock.state.gcodes).toEqual([]);
  }, 25000);

  it("resume_job force=true needs approval, a plain resume does not", async () => {
    const paused = { status: "paused", job: { layer: 0, filePosition: 5, file: { size: 1000, fileName: "0:/gcodes/t.gcode" } } };
    const dec = await bootServer({ readOnly: false, elicit: "decline", initial: paused });
    const r = await dec.call("resume_job", { force: true });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/job stays paused/);
    expect(dec.mock.state.gcodes).toEqual([]);
  }, 25000);

  it("emergency stop and the read tools never ask", async () => {
    const { mock, call, prompts } = await bootServer({ readOnly: false, elicit: "decline" });
    await call("emergency_stop");
    await call("get_status");
    await call("job_status");
    expect(prompts).toEqual([]);
    expect(mock.state.gcodes).toEqual(["M112"]);
  }, 25000);

  it("tools carry hints for clients: read-only for reads, destructive for control", async () => {
    const { client } = await bootServer({ readOnly: false });
    const tools = (await client.listTools()).tools;
    const hint = (n: string) => tools.find((t) => t.name === n)?.annotations;
    expect(hint("get_status")?.readOnlyHint).toBe(true);
    expect(hint("job_status")?.readOnlyHint).toBe(true);
    expect(hint("send_gcode")?.destructiveHint).toBe(true);
    expect(hint("start_job")?.readOnlyHint).toBe(false);
    expect(hint("emergency_stop")?.destructiveHint).toBe(false);
    expect(hint("pause_job")?.destructiveHint).toBe(false);
  }, 25000);
});
