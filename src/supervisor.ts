/**
 * Print supervision: pure rules, no I/O. The server feeds it samples and carries out the returned actions.
 * Rules run in the server so safety does not depend on a chat being open.
 * Note: the firmware keeps its own protections (heater fault monitoring, M143 limits); these rules react earlier.
 */

export interface HeaterSample {
  role: "bed" | "tool" | "other";
  current: number;
  target: number; // effective target: 0 when the heater is off or its target is 0
  state: string; // RRF heater state: off, standby, active, fault, tuning
}

export interface Sample {
  t: number; // ms timestamp
  status: string; // RRF state.status
  heaters: HeaterSample[];
  filePosition: number;
  fileSize: number;
  fileName?: string;
  layer?: number; // firmware job.layer, 1 = first layer
  upTime?: number; // seconds since the board booted (state.upTime); a drop means the board restarted
}

export interface SupervisorConfig {
  devTool: number; // C allowed deviation from target once settled
  devBed: number;
  devSeconds: number; // how long a deviation must last
  heatupMinutes: number; // target not reached within this time while printing
  stallSeconds: number; // no job progress while nothing is heating
  stallAction: "warn" | "pause";
  maxTool: number; // hard limits in C
  maxBed: number;
  runawayMargin: number; // C above target once settled
  settleTool: number; // |current - target| within this counts as reached
  settleBed: number;
}

export const DEFAULT_SUPERVISOR: SupervisorConfig = {
  devTool: 15, devBed: 10, devSeconds: 45, heatupMinutes: 8, stallSeconds: 180, stallAction: "warn",
  maxTool: 260, maxBed: 100, runawayMargin: 25, settleTool: 5, settleBed: 3,
};

export function supervisorConfigFromEnv(env: Record<string, string | undefined>, maxTemp: { bed: number; tool: number }): SupervisorConfig {
  const n = (v: string | undefined, d: number) => (v !== undefined && v !== "" && !isNaN(+v) ? +v : d);
  return {
    ...DEFAULT_SUPERVISOR,
    devTool: n(env.DUET_TEMP_DEV_TOOL, DEFAULT_SUPERVISOR.devTool),
    devBed: n(env.DUET_TEMP_DEV_BED, DEFAULT_SUPERVISOR.devBed),
    devSeconds: n(env.DUET_TEMP_DEV_SECONDS, DEFAULT_SUPERVISOR.devSeconds),
    heatupMinutes: n(env.DUET_HEATUP_MINUTES, DEFAULT_SUPERVISOR.heatupMinutes),
    stallSeconds: n(env.DUET_STALL_SECONDS, DEFAULT_SUPERVISOR.stallSeconds),
    stallAction: env.DUET_STALL_ACTION === "pause" ? "pause" : "warn",
    maxTool: maxTemp.tool,
    maxBed: maxTemp.bed,
  };
}

export type Level = "info" | "warning" | "error";
export interface SupervisorEvent { t: number; level: Level; code: string; message: string }
export type Action = { type: "pause" | "heaters-off"; reason: string };
export interface Result { events: SupervisorEvent[]; actions: Action[] }

interface HeaterTrack { target: number; since: number; settled: boolean; devSince?: number }

export class JobSupervisor {
  private fired = new Set<string>();
  private heaters: HeaterTrack[] = [];
  private prevStatus = "idle";
  private lastPos = -1;
  private lastPosAt = 0;
  private lastRatio = 0;
  private lastFile?: string;
  private lastUpTime?: number;

  constructor(private cfg: SupervisorConfig = DEFAULT_SUPERVISOR) {}

  evaluate(s: Sample): Result {
    const events: SupervisorEvent[] = [];
    const actions: Action[] = [];
    const say = (level: Level, code: string, message: string) => events.push({ t: s.t, level, code, message });
    // Fires once per episode; `clear(key)` re-arms it.
    const fire = (key: string, level: Level, code: string, message: string, action?: Action[]) => {
      if (this.fired.has(key)) return;
      this.fired.add(key);
      say(level, code, message);
      if (action) actions.push(...action);
    };
    const clear = (key: string) => this.fired.delete(key);
    // --- board restart: the uptime goes backwards. Heaters are off, axes unhomed, a running job is gone.
    if (s.upTime !== undefined) {
      if (this.lastUpTime !== undefined && s.upTime + 2 < this.lastUpTime) {
        const wasActive = ["processing", "paused", "pausing", "resuming"].includes(this.prevStatus);
        say("warning", "duet-restarted", `The Duet restarted (uptime ${Math.round(s.upTime)} s). Heater targets are 0 and axes are not homed${wasActive ? `; the job that was running at ${Math.round(this.lastRatio * 100)} % is gone (a pause may have left 0:/sys/resurrect.g)` : ""}.`);
        this.fired.clear();
        this.heaters = [];
        this.prevStatus = "idle"; // do not additionally report "job ended early"
        this.lastPos = -1;
      }
      this.lastUpTime = s.upTime;
    }
    const printing = s.status === "processing";
    const prev = this.prevStatus;

    // --- job lifecycle
    if (printing && prev !== "processing") {
      if (prev === "paused" || prev === "pausing" || prev === "resuming") {
        say("info", "job-resumed", "Job resumed.");
        this.lastPosAt = s.t;
        for (const k of [...this.fired]) if (/^(dev|heatup|stall)/.test(k)) this.fired.delete(k);
        this.heaters.forEach((h) => { h.devSince = undefined; });
      } else {
        this.fired.clear();
        this.heaters = [];
        this.lastPos = -1;
        this.lastPosAt = s.t;
        this.lastFile = s.fileName;
        say("info", "job-started", `Job started${s.fileName ? `: ${s.fileName}` : ""}.`);
      }
    }
    // A job can end from any active state: a cancel usually goes through "paused" (the firmware demands M25 before M0).
    if (["processing", "paused", "pausing", "resuming", "cancelling"].includes(prev) && s.status === "idle") {
      const pct = Math.round(this.lastRatio * 100);
      if (this.lastRatio >= 0.98) say("info", "job-finished", `Job finished${this.lastFile ? `: ${this.lastFile}` : ""}.`);
      else say("warning", "job-ended-early", `Job ended at ${pct} %: cancelled, board reset or error. Check the machine.`);
    }
    if (s.status === "paused" && (prev === "processing" || prev === "pausing")) say("info", "job-paused", "Job is paused.");
    if (s.status === "halted") fire("halted", "error", "machine-halted", "The machine is halted (emergency stop or firmware error). Restart needed.");
    else clear("halted");

    // --- heaters (all statuses for limits, printing only for time based rules)
    s.heaters.forEach((h, i) => {
      const tr = (this.heaters[i] ??= { target: h.target, since: s.t, settled: false });
      const settleTol = h.role === "bed" ? this.cfg.settleBed : this.cfg.settleTool;
      const dev = h.role === "bed" ? this.cfg.devBed : this.cfg.devTool;
      const label = `${h.role === "bed" ? "Bed" : "Nozzle"} (heater ${i})`;

      if (h.target !== tr.target) { // new target: a heat-up (or cool-down) phase starts, nothing counts as a deviation until it settled
        tr.target = h.target; tr.since = s.t; tr.settled = false; tr.devSince = undefined;
        clear(`dev${i}`); clear(`heatup${i}`);
      }
      const limit = h.role === "bed" ? this.cfg.maxBed : h.role === "tool" ? this.cfg.maxTool : Infinity;
      if (h.state === "fault") {
        fire(`fault${i}`, "error", "heater-fault", `${label} reports a fault.`, [{ type: "heaters-off", reason: "heater fault" }, ...(printing ? [{ type: "pause" as const, reason: "heater fault" }] : [])]);
      } else clear(`fault${i}`);
      if (h.current > limit) {
        fire(`over${i}`, "error", "over-temperature", `${label} is at ${h.current} C, above the limit of ${limit} C. Heaters off.`, [{ type: "heaters-off", reason: "over-temperature" }, ...(printing ? [{ type: "pause" as const, reason: "over-temperature" }] : [])]);
      } else if (h.target > 0 && tr.settled && h.current > h.target + this.cfg.runawayMargin) {
        fire(`over${i}`, "error", "temperature-runaway", `${label} is at ${h.current} C, ${this.cfg.runawayMargin}+ C above its target of ${h.target} C. Heaters off.`, [{ type: "heaters-off", reason: "temperature runaway" }, ...(printing ? [{ type: "pause" as const, reason: "temperature runaway" }] : [])]);
      } else if (h.current <= limit && !(h.target > 0 && tr.settled && h.current > h.target + this.cfg.runawayMargin)) clear(`over${i}`);

      if (h.target > 0) {
        if (!tr.settled && Math.abs(h.current - h.target) <= settleTol) tr.settled = true;
        if (!tr.settled) {
          if (printing && s.t - tr.since > this.cfg.heatupMinutes * 60_000) {
            fire(`heatup${i}`, "error", "heatup-timeout", `${label} did not reach ${h.target} C within ${this.cfg.heatupMinutes} min (now ${h.current} C). Heater or sensor problem?`, [{ type: "pause", reason: "heat-up timeout" }]);
          }
        } else if (Math.abs(h.current - h.target) > dev) {
          tr.devSince ??= s.t;
          if (printing && s.t - tr.devSince >= this.cfg.devSeconds * 1000) {
            fire(`dev${i}`, "error", "temperature-deviation", `${label} is at ${h.current} C, more than ${dev} C from its target of ${h.target} C for ${this.cfg.devSeconds}+ s.`, [{ type: "pause", reason: "temperature deviation" }]);
          }
        } else { tr.devSince = undefined; clear(`dev${i}`); }
      } else { tr.settled = false; tr.devSince = undefined; }
    });

    // --- progress
    if (printing) {
      if (s.fileSize > 0) this.lastRatio = s.filePosition / s.fileSize;
      const heating = s.heaters.some((h, i) => h.target > 0 && !this.heaters[i]?.settled);
      if (s.filePosition !== this.lastPos || heating) {
        this.lastPos = s.filePosition; this.lastPosAt = s.t; clear("stall");
      } else if (s.t - this.lastPosAt >= this.cfg.stallSeconds * 1000) {
        fire("stall", this.cfg.stallAction === "pause" ? "error" : "warning", "no-progress",
          `The job made no progress for ${Math.round((s.t - this.lastPosAt) / 1000)} s while nothing is heating.`,
          this.cfg.stallAction === "pause" ? [{ type: "pause", reason: "no progress" }] : undefined);
      }
    }
    this.prevStatus = s.status;
    return { events, actions };
  }
}

/** Tracks reachability of the machine. The printer keeps running without us, so a loss can only be reported, not acted on. */
export class ConnectionTracker {
  private failSince?: number;
  private lostReported = false;
  private authReported = false;

  constructor(private lossSeconds = 60) {}

  ok(t: number): SupervisorEvent[] {
    const out: SupervisorEvent[] = [];
    if (this.lostReported || this.authReported) out.push({ t, level: "info", code: "connection-restored", message: "Connection to the Duet is back." });
    this.failSince = undefined; this.lostReported = false; this.authReported = false;
    return out;
  }

  fail(t: number, error: string, kind?: string): SupervisorEvent[] {
    const out: SupervisorEvent[] = [];
    this.failSince ??= t;
    const auth = kind !== undefined ? kind === "auth" : /err[= ]1\b|password/i.test(error);
    if (auth) {
      if (!this.authReported) {
        this.authReported = true;
        out.push({ t, level: "error", code: "auth-failed", message: "The Duet rejects the password (it may have been changed or the board restarted). Supervision is blind until DUET_PASSWORD is fixed. A running job continues on its own." });
      }
    } else if (!this.lostReported && t - this.failSince >= this.lossSeconds * 1000) {
      this.lostReported = true;
      out.push({ t, level: "warning", code: "connection-lost", message: `No connection to the Duet for ${this.lossSeconds}+ s. A running job continues on its own, unsupervised (${error}).` });
    }
    return out;
  }
}
