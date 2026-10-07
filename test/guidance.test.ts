import { afterEach, describe, expect, it } from "vitest";
import { INSTRUCTIONS, PROMPTS } from "../src/prompts.js";
import { bootServer, closeAll } from "./helpers/bootServer.js";

afterEach(closeAll);

describe("prompt texts", () => {
  it("have unique names, titles and descriptions", () => {
    expect(new Set(PROMPTS.map((p) => p.name)).size).toBe(PROMPTS.length);
    for (const p of PROMPTS) { expect(p.title.length).toBeGreaterThan(3); expect(p.description.length).toBeGreaterThan(20); }
  });
  it("put the arguments into the text", () => {
    const pre = PROMPTS.find((p) => p.name === "pre_print_check")!;
    const t = pre.build({ file: "C:/x/cube.gcode", nozzle: "1.0" });
    expect(t).toMatch(/cube\.gcode/);
    expect(t).toMatch(/nozzle=1\.0/);
    expect(pre.build({ file: "a.gcode" })).toMatch(/ask for the nozzle diameter/);
    expect(PROMPTS.find((p) => p.name === "start_print_supervised")!.build({ file: "t.gcode", profile: "1:30,2:50" })).toMatch(/set_speed_profile with "1:30,2:50"/);
  });
});

describe("what a fresh client sees (simulated Duet)", () => {
  it("gets instructions that name the safe workflow", async () => {
    const { client } = await bootServer({ readOnly: false });
    const i = client.getInstructions() ?? "";
    expect(i).toBe(INSTRUCTIONS);
    for (const w of ["get_machine_info", "job_status", "preflight_gcode", "start_job", "approval", "emergency_stop"]) expect(i).toContain(w);
  }, 25000);

  it("every tool the guidance mentions really exists", async () => {
    const { client } = await bootServer({ readOnly: false });
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    const allowed = new Set([...names, ...PROMPTS.map((p) => p.name)]);
    const text = INSTRUCTIONS + "\n" + PROMPTS.map((p) => p.build({ file: "f", nozzle: "0.4", profile: "1:30", material: "PLA", points: "4" })).join("\n");
    const mentioned = new Set(text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []);
    const unknown = [...mentioned].filter((w) => !allowed.has(w));
    expect(unknown).toEqual([]);
  }, 25000);

  it("has a clear description on every tool", async () => {
    const { client } = await bootServer({ readOnly: false });
    for (const t of (await client.listTools()).tools) {
      expect(t.description?.length ?? 0, t.name).toBeGreaterThan(30);
      expect(t.description!.length, t.name).toBeLessThan(900);
    }
  }, 25000);

  it("offers the prompts and fills in their arguments", async () => {
    const { client } = await bootServer({ readOnly: true });
    const names = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(names).toEqual(["bed_leveling_assistant", "first_layer_profile", "pre_print_check", "start_print_supervised", "troubleshoot_connection"]);
    const p = await client.getPrompt({ name: "pre_print_check", arguments: { file: "D:/g/cube.gcode", nozzle: "0.6" } });
    const t = (p.messages[0].content as any).text as string;
    expect(t).toMatch(/cube\.gcode/);
    expect(t).toMatch(/preflight_gcode/);
    const t2 = ((await client.getPrompt({ name: "troubleshoot_connection" })).messages[0].content as any).text as string;
    expect(t2).toMatch(/rejected the password/);
  }, 25000);

  it("offers resources for the profile, config.g, settings and events", async () => {
    const { client } = await bootServer({ readOnly: true });
    const uris = (await client.listResources()).resources.map((r) => r.uri).sort();
    expect(uris).toEqual(["duet://events/recent", "duet://machine/config.g", "duet://machine/profile", "duet://server/settings"]);
    const read = async (uri: string) => ((await client.readResource({ uri })).contents[0] as any).text as string;
    expect(JSON.parse(await read("duet://machine/profile")).axisLimits.X.max).toBe(220);
    expect(await read("duet://machine/config.g")).toMatch(/M208 X220/);
    const settings = JSON.parse(await read("duet://server/settings"));
    expect(settings.readOnly).toBe(true);
    expect(settings.confirmMode).toBe("auto");
    expect(await read("duet://events/recent")).toMatch(/No events yet|job-/);
  }, 25000);

  it("keeps get_status and get_endstops short and readable", async () => {
    const { call } = await bootServer({ readOnly: true, initial: { sensors: { endstops: [{ triggered: true, type: "inputPin" }, { triggered: false, type: "inputPin" }, null], probes: [], filamentMonitors: [], analogSensors: [] } } });
    const s = await call("get_status");
    const j = JSON.parse(s.text);
    expect(j.heaters[1]).toMatchObject({ role: "tool" });
    expect(j.axes.map((a: any) => a.letter)).toEqual(["X", "Y", "Z"]);
    expect(s.text.length).toBeLessThan(1500);
    const e = JSON.parse((await call("get_endstops")).text);
    expect(e).toEqual([{ axis: "X", triggered: true, type: "inputPin" }, { axis: "Y", triggered: false, type: "inputPin" }]);
  }, 25000);
});
