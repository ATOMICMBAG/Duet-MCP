import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendAudit, GENESIS, verifyAudit } from "../src/audit.js";
import { bootServer, closeAll } from "./helpers/bootServer.js";

afterEach(closeAll);

const tmp = () => join(mkdtempSync(join(tmpdir(), "audit-")), "audit.log");
const fill = (file: string, n = 4, key?: string) => { for (let i = 0; i < n; i++) appendAudit(file, { tool: "send_gcode", args: { gcode: `M105 ; ${i}` } }, key); };
const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);
const write = (file: string, ls: string[]) => writeFileSync(file, ls.join("\n") + "\n");

describe("audit chain", () => {
  it("chains every line to the one before and verifies", () => {
    const f = tmp();
    fill(f);
    const ls = lines(f).map((l) => JSON.parse(l));
    expect(ls[0].prev).toBe(GENESIS);
    expect(ls[1].prev).toBe(ls[0].h);
    expect(ls[3].prev).toBe(ls[2].h);
    expect(verifyAudit(readFileSync(f, "utf8"))).toMatchObject({ ok: true, lines: 4, chained: 4, legacy: 0, problems: [] });
  });

  it("finds a line that was added by hand (the 'test-result' case)", () => {
    const f = tmp();
    fill(f);
    const ls = lines(f);
    ls.splice(2, 0, JSON.stringify({ t: "2026-10-12T11:37:00.000Z", tool: "test-result", result: "ok", detail: "everything fine" }));
    write(f, ls);
    const r = verifyAudit(readFileSync(f, "utf8"));
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/line 3: no checksum, not written by the server \(test-result\)/);
    expect(r.problems).toHaveLength(1); // only the foreign line is named; the server's own lines after it are still intact
  });

  it("finds an edited and a removed line", () => {
    const f = tmp();
    fill(f);
    const edited = lines(f);
    edited[1] = edited[1].replace("M105 ; 1", "M104 S300");
    write(f, edited);
    expect(verifyAudit(readFileSync(f, "utf8")).problems.join("\n")).toMatch(/line 2: checksum does not match/);

    const g = tmp();
    fill(g);
    const ls = lines(g);
    ls.splice(1, 1);
    write(g, ls);
    expect(verifyAudit(readFileSync(g, "utf8")).problems.join("\n")).toMatch(/line 2: wrong predecessor/);
  });

  it("notices lines removed from the start, but accepts the end being cut (cannot be known)", () => {
    const f = tmp();
    fill(f);
    const ls = lines(f);
    write(f, ls.slice(1));
    expect(verifyAudit(readFileSync(f, "utf8")).problems.join("\n")).toMatch(/starts with an unknown predecessor/);
    write(f, ls.slice(0, 2));
    expect(verifyAudit(readFileSync(f, "utf8")).ok).toBe(true);
  });

  it("continues an old unchained log and keeps it readable", () => {
    const f = tmp();
    appendFileSync(f, JSON.stringify({ t: "2026-10-07T10:00:00.000Z", tool: "send_gcode", args: {} }) + "\n");
    fill(f, 2);
    const r = verifyAudit(readFileSync(f, "utf8"));
    expect(r).toMatchObject({ ok: true, legacy: 1, chained: 2 });
    expect(JSON.parse(lines(f)[1]).prev).toBe("legacy");
  });

  it("with a key, a chain rebuilt without the key does not verify", () => {
    const f = tmp();
    fill(f, 3, "secret");
    expect(verifyAudit(readFileSync(f, "utf8"), "secret").ok).toBe(true);
    expect(verifyAudit(readFileSync(f, "utf8"), "wrong").ok).toBe(false);
    expect(verifyAudit(readFileSync(f, "utf8")).ok).toBe(false);
    // someone rewrites the file with a plain (keyless) chain
    const forged = tmp();
    fill(forged, 3);
    expect(verifyAudit(readFileSync(forged, "utf8"), "secret").ok).toBe(false);
  });

  it("two writers sharing one file keep one chain", () => {
    const f = tmp();
    appendAudit(f, { tool: "a" });
    appendAudit(f, { tool: "b" }); // another process appends in between: the next write reads the file again
    appendAudit(f, { tool: "c" });
    expect(verifyAudit(readFileSync(f, "utf8")).ok).toBe(true);
  });
});

describe("the server writes a chained log", () => {
  it("every action of a real session verifies, and an inserted line is found", async () => {
    const { call, auditFile } = await bootServer({ readOnly: false });
    await call("send_gcode", { gcode: "M105" });
    await call("pause_job");
    await new Promise((r) => setTimeout(r, 300));
    const text = readFileSync(auditFile, "utf8");
    const r = verifyAudit(text);
    expect(r.ok).toBe(true);
    expect(r.chained).toBeGreaterThanOrEqual(3);
    appendFileSync(auditFile, JSON.stringify({ t: "x", tool: "note", detail: "added by an assistant" }) + "\n");
    expect(verifyAudit(readFileSync(auditFile, "utf8")).ok).toBe(false);
  }, 30000);
});
