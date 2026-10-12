import { afterEach, describe, expect, it } from "vitest";
import { checkGcode } from "../src/guard.js";
import { canAcknowledge, describeMessageBox, isFilamentRelated, parseMessageBox, waitsForAnswer } from "../src/messagebox.js";
import { JobSupervisor, type Sample } from "../src/supervisor.js";
import { bootServer, closeAll } from "./helpers/bootServer.js";

afterEach(closeAll);

const box = (mode: number, message: string, title = "") => ({ mode, title, message, timeout: 0 });
const sample = (t: number, messageBox?: Sample["messageBox"], status = "paused"): Sample => ({ t, status, heaters: [], filePosition: 10, fileSize: 100, messageBox });

describe("message box helpers", () => {
  it("parses what the firmware sends and ignores empty boxes", () => {
    expect(parseMessageBox(null)).toBeUndefined();
    expect(parseMessageBox({ mode: 2, message: "", title: "" })).toBeUndefined();
    expect(parseMessageBox(box(2, "Load filament", "Filament change"))).toMatchObject({ mode: 2, title: "Filament change" });
  });
  it("tells what can be answered", () => {
    expect([0, 1, 2, 3, 4, 7].map((m) => canAcknowledge(parseMessageBox(box(m, "x"))!))).toEqual([false, true, true, true, false, false]);
    expect([0, 1, 2, 3].map((m) => waitsForAnswer(parseMessageBox(box(m, "x"))!))).toEqual([false, false, true, true]);
    expect(isFilamentRelated(box(2, "Insert new filament and press OK"))).toBe(true);
    expect(isFilamentRelated(box(2, "Check the bed"))).toBe(false);
    expect(describeMessageBox(box(3, "Continue?", "Check"))).toBe('"Check": Continue? [waits for OK or Cancel]');
  });
  it("send_gcode cannot answer a message box without approval", () => {
    const cfg: any = { host: "x", password: "", readOnly: false, cameras: {}, macros: [], maxTemp: { bed: 100, tool: 260 } };
    const v = checkGcode("M292", cfg, undefined, false);
    expect(v.ok).toBe(false);
    expect((v as any).confirmable).toBe(true);
    expect(checkGcode("M291 P\"Hello\" S1", cfg, undefined, false).ok).toBe(true);
  });
});

describe("supervisor reports messages", () => {
  it("reports a filament change once, and when it is answered", () => {
    const sup = new JobSupervisor();
    sup.evaluate(sample(0, undefined, "processing"));
    const a = sup.evaluate(sample(1000, box(2, "Insert new filament and press OK", "Filament change")));
    expect(a.events.find((e) => e.code === "filament-change")?.level).toBe("warning");
    expect(sup.evaluate(sample(2000, box(2, "Insert new filament and press OK", "Filament change"))).events.filter((e) => /message|filament/.test(e.code))).toEqual([]);
    expect(sup.evaluate(sample(3000, undefined, "processing")).events.some((e) => e.code === "message-closed")).toBe(true);
  });
  it("reports other messages by how urgent they are", () => {
    const sup = new JobSupervisor();
    expect(sup.evaluate(sample(0, box(0, "Heating done"), "idle")).events.find((e) => e.code === "message-box")?.level).toBe("info");
    expect(sup.evaluate(sample(1, box(3, "Bed clear?"), "idle")).events.find((e) => e.code === "message-box")?.level).toBe("warning");
  });
});

describe("acknowledge_message (simulated Duet)", () => {
  const filament = { mode: 2, title: "Filament change", message: "Insert new filament and press OK", timeout: 0 };

  it("shows the message in job_status and as an event, answers with M292 after approval", async () => {
    const { mock, call, status, prompts } = await bootServer({ readOnly: false, initial: { messageBox: filament, status: "paused" } });
    await new Promise((r) => setTimeout(r, 800));
    const s = await status();
    expect(s).toMatch(/MESSAGE ON THE MACHINE: "Filament change": Insert new filament/);
    expect(s).toMatch(/filament-change/);
    const r = await call("acknowledge_message", { action: "ok" });
    expect(r.isError).toBe(false);
    expect(prompts.join("\n")).toMatch(/Insert new filament/);
    expect(mock.state.gcodes).toContain("M292");
    expect(mock.state.messageBox).toBeNull();
    expect((await call("acknowledge_message")).isError).toBe(true); // nothing left to answer
  }, 30000);

  it("does not answer when the user declines", async () => {
    const { mock, call } = await bootServer({ readOnly: false, elicit: "decline", initial: { messageBox: filament, status: "paused" } });
    const r = await call("acknowledge_message");
    expect(r.isError).toBe(true);
    expect(mock.state.gcodes).not.toContain("M292");
    expect(mock.state.messageBox).not.toBeNull();
  }, 30000);

  it("refuses cancel on a box without Cancel and boxes that need a value", async () => {
    const { mock, call } = await bootServer({ readOnly: false, initial: { messageBox: filament, status: "paused" } });
    expect((await call("acknowledge_message", { action: "cancel" })).text).toMatch(/no Cancel/);
    mock.state.messageBox = { mode: 5, title: "", message: "Enter a number", timeout: 0 };
    expect((await call("acknowledge_message")).text).toMatch(/cannot be answered here/);
    expect(mock.state.gcodes).not.toContain("M292");
  }, 30000);

  it("is not offered in read-only mode", async () => {
    const { client } = await bootServer({ readOnly: true });
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("acknowledge_message");
  }, 30000);
});
