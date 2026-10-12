import type { RequestEvent } from "./duet.js";

/**
 * What was asked, summarised for the cockpit: how often the assistant called each tool, and what was read from the machine by whom
 * (the supervisor's polling, the cockpit page itself, the assistant's reads). Counts and times only; arguments are not kept.
 * Memory only, gone when the server stops.
 */
export interface ReadSummary { source: string; count: number; perMinute: number; last: number; what: string[] }
export interface ToolSummary { name: string; count: number; last: number }
export interface QuerySummary { reads: ReadSummary[]; tools: ToolSummary[]; sinceT: number }

const WINDOW_MS = 5 * 60_000;
const clip = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class QueryStats {
  private reads = new Map<string, { count: number; last: number; times: number[]; keys: Map<string, number> }>();
  private tools = new Map<string, { count: number; last: number }>();
  readonly startedAt: number;
  constructor(now = Date.now()) { this.startedAt = now; }

  /** A read from the machine (status, heaters, files ...). G-code and uploads are listed elsewhere (activity.ts). */
  read(e: RequestEvent) {
    if (e.kind === "gcode" || e.kind === "upload") return;
    const source = e.source ?? "server";
    const g = this.reads.get(source) ?? { count: 0, last: 0, times: [], keys: new Map<string, number>() };
    g.count++;
    g.last = e.t;
    g.times.push(e.t);
    while (g.times.length && e.t - g.times[0] > WINDOW_MS) g.times.shift();
    const key = clip(`${e.kind} ${e.detail || "(all)"}`);
    g.keys.set(key, (g.keys.get(key) ?? 0) + 1);
    this.reads.set(source, g);
  }

  tool(name: string, t = Date.now()) {
    const x = this.tools.get(name) ?? { count: 0, last: 0 };
    x.count++;
    x.last = t;
    this.tools.set(name, x);
  }

  summary(now = Date.now(), maxTools = 10, maxReads = 6): QuerySummary {
    const reads = [...this.reads.entries()]
      .map(([source, g]) => ({
        source, count: g.count, last: g.last,
        perMinute: Math.round((g.times.filter((t) => now - t <= 60_000).length) * 10) / 10,
        what: [...g.keys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k),
      }))
      .sort((a, b) => b.last - a.last)
      .slice(0, maxReads);
    const tools = [...this.tools.entries()].map(([name, x]) => ({ name, count: x.count, last: x.last })).sort((a, b) => b.last - a.last).slice(0, maxTools);
    return { reads, tools, sinceT: this.startedAt };
  }
}
