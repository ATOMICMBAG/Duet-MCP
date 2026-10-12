import { createHash, createHmac } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * Tamper-evident audit log: every line carries `prev` (the checksum of the line before) and `h` (the checksum of this line).
 * A line that is inserted, edited or removed in the middle breaks the chain and `verifyAudit` says where.
 * With DUET_AUDIT_KEY set the checksum is an HMAC, so nobody without the key can rebuild a consistent chain.
 * Without the key it still catches accidents and lines added by hand or by an assistant, but not someone who rewrites the whole file on purpose.
 */
export const GENESIS = "genesis";

const checksum = (key: string | undefined, prev: string, body: string) => {
  const data = `${prev}|${body}`;
  return (key ? createHmac("sha256", key).update(data) : createHash("sha256").update(data)).digest("hex").slice(0, 32);
};

/** The last non-empty line of a file (reads only the end). */
function lastLine(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, 16384);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split(/\r?\n/).filter((l) => l.trim());
    return lines[lines.length - 1];
  } finally { closeSync(fd); }
}

/** Checksum to chain the next line to: the last line's `h`, or "legacy" after an old unchained log, or the genesis. */
function previous(file: string): string {
  const last = lastLine(file);
  if (last === undefined) return GENESIS;
  try {
    const h = JSON.parse(last).h;
    if (typeof h === "string") return h;
  } catch { /* not JSON: treated like a legacy line */ }
  return "legacy";
}

export function appendAudit(file: string, entry: Record<string, unknown>, key = process.env.DUET_AUDIT_KEY || undefined, now = () => new Date()): void {
  const body = JSON.stringify({ t: now().toISOString(), ...entry });
  const prev = previous(file); // read from the file every time: several server processes may share one log
  const h = checksum(key, prev, body);
  appendFileSync(file, JSON.stringify({ ...JSON.parse(body), prev, h }) + "\n");
}

export interface AuditReport { ok: boolean; lines: number; chained: number; legacy: number; problems: string[] }

export function verifyAudit(text: string, key = process.env.DUET_AUDIT_KEY || undefined): AuditReport {
  const rep: AuditReport = { ok: true, lines: 0, chained: 0, legacy: 0, problems: [] };
  let prev: string | undefined; // checksum expected as `prev` of the next chained line; undefined before the first chained line
  let started = false;
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    if (!raw.trim()) return;
    rep.lines++;
    const no = idx + 1;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(raw); } catch { rep.problems.push(`line ${no}: not valid JSON`); return; }
    if (typeof obj.h !== "string" || typeof obj.prev !== "string") {
      if (started) rep.problems.push(`line ${no}: no checksum, not written by the server (${String(obj.tool ?? "?")}); it breaks the chain`);
      else rep.legacy++;
      return;
    }
    const { prev: p, h, ...rest } = obj as { prev: string; h: string } & Record<string, unknown>;
    if (!started) {
      started = true;
      if (p !== GENESIS && p !== "legacy") rep.problems.push(`line ${no}: the chain starts with an unknown predecessor (earlier lines were removed?)`);
    } else if (p !== prev) {
      rep.problems.push(`line ${no}: wrong predecessor (a line before it was removed, changed or inserted)`);
    }
    if (checksum(key, p, JSON.stringify(rest)) !== h) rep.problems.push(`line ${no}: checksum does not match the content (the line was edited${key ? "" : ", or DUET_AUDIT_KEY is needed"})`);
    prev = h;
    rep.chained++;
  });
  rep.ok = rep.problems.length === 0;
  return rep;
}
