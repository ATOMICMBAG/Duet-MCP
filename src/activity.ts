import type { RequestEvent } from "./duet.js";
import { redactSecrets } from "./profile.js";

/**
 * What the machine was sent, and what was decided about it: the list shown in the cockpit.
 * `sent` entries are G-code lines and uploads that went to the Duet; `decision` entries are the guard's refusals and the user's answers.
 * Kept in memory only (the last 200), never written anywhere.
 */
export interface ActivityEntry {
  t: number;
  kind: "sent" | "decision";
  source: string; // who: "assistant: send_gcode", "supervisor", "speed profile", "idle watchdog", "you", "server"
  text: string;
  level: "ok" | "warn" | "error";
}

export class ActivityLog {
  private items: ActivityEntry[] = [];
  constructor(private max = 200) {}
  add(e: ActivityEntry) {
    this.items.push(e);
    if (this.items.length > this.max) this.items.shift();
  }
  /** Newest first. */
  recent(n: number): ActivityEntry[] { return this.items.slice(-n).reverse(); }
  get size() { return this.items.length; }
}

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** G-code lines and uploads become `sent` entries. Reads (status, files ...) are not listed here. */
export function describeRequest(e: RequestEvent): ActivityEntry | undefined {
  const source = e.source ?? "server";
  if (e.kind === "gcode") {
    const lines = e.detail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const text = clip(redactSecrets(lines.join("  |  ")));
    return e.ok
      ? { t: e.t, kind: "sent", source, text, level: "ok" }
      : { t: e.t, kind: "sent", source, text: `${text}  ->  ${clip(redactSecrets(e.error ?? "failed"), 100)}`, level: "error" };
  }
  if (e.kind === "upload") {
    const text = `Upload to ${e.detail}`;
    return e.ok ? { t: e.t, kind: "sent", source, text, level: "ok" } : { t: e.t, kind: "sent", source, text: `${text}  ->  ${clip(e.error ?? "failed", 100)}`, level: "error" };
  }
  return undefined;
}
