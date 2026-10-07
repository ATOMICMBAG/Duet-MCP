#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, loadDotEnv } from "./config.js";
import { DuetClient } from "./duet.js";
import { checkGcode } from "./guard.js";
import { grabFrame, listDshowDevices } from "./camera.js";
import { mergeLive, parseConfig, redactSecrets, type MachineProfile } from "./profile.js";
import { homeAxes, orderAxes } from "./homing.js";
import { makeConfirmer, parseConfirmMode, systemDialog, type ConfirmRequest } from "./confirm.js";
import { SpeedGovernor, formatSpeedProfile, parseSpeedProfile, type SpeedStep } from "./speedprofile.js";
import { cancelJob, resumeJob } from "./jobcontrol.js";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { analyzeGcode, applyFixes, formatReport } from "./preflight.js";
import { HeatWatchdog } from "./watchdog.js";
import { ConnectionTracker, JobSupervisor, supervisorConfigFromEnv, type Action, type HeaterSample, type Sample, type SupervisorEvent } from "./supervisor.js";

// Append-only audit trail of every control action (what was asked, with which args, and what happened).
const auditFile = process.env.DUET_AUDIT_LOG ?? "duet-mcp-audit.log";
const audit = (entry: Record<string, unknown>) => {
  try { appendFileSync(auditFile, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n"); } catch { /* never block a safety action on logging */ }
};
const homedMap = async (): Promise<Record<string, boolean>> =>
  Object.fromEntries((await duet.model("move.axes")).map((a: any) => [a.letter, !!a.homed]));

loadDotEnv();
const cfg = loadConfig();
const duet = new DuetClient(cfg.host, cfg.password);
const server = new McpServer({ name: "duet-mcp", version: "0.1.0" }, { capabilities: { logging: {} } });

let profile: MachineProfile | undefined;
async function getProfile(refresh = false): Promise<MachineProfile> {
  if (!profile || refresh) {
    const base = parseConfig(await duet.download("0:/sys/config.g"));
    const [axes, heaters, kin] = await Promise.all([duet.model("move.axes").catch(() => undefined), duet.model("heat.heaters").catch(() => undefined), duet.model("move.kinematics").catch(() => undefined)]);
    profile = mergeLive(base, axes, heaters, kin?.name);
  }
  return profile;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const fail = (t: string) => ({ ...text(t), isError: true });

// --- Human confirmation (B1): the server asks the user itself; the model cannot approve for them.
async function elicit(req: ConfirmRequest): Promise<"accept" | "decline" | "unsupported"> {
  if (!server.server.getClientCapabilities()?.elicitation) return "unsupported";
  try {
    const r = await server.server.elicitInput(
      { message: `${req.title}\n\n${req.message}`, requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Approve", description: "Tick to approve, then accept" } }, required: ["approve"] } },
      { timeout: Number(process.env.DUET_CONFIRM_TIMEOUT ?? 120) * 1000 },
    );
    return r.action === "accept" && r.content?.approve === true ? "accept" : "decline";
  } catch { return "unsupported"; } // the client refused the request type: fall back to the next way to ask
}
const confirmer = makeConfirmer({ mode: parseConfirmMode(process.env.DUET_CONFIRM), elicit, dialog: systemDialog(Number(process.env.DUET_CONFIRM_TIMEOUT ?? 120)) });
async function ask(title: string, message: string, modelConfirmed: boolean) {
  const r = await confirmer({ title, message, modelConfirmed });
  audit({ tool: "confirmation", title, approved: r.approved, via: r.via });
  return r;
}

// Control tools are only registered when DUET_READ_ONLY=false (default: true).
const control = (name: string, description: string, inputSchema: any, handler: (a: any) => Promise<any>, annotations: Record<string, boolean> = {}) => {
  if (cfg.readOnly) return;
  server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, ...annotations } }, async (args: any) => {
    audit({ tool: name, args });
    try {
      const res = await handler(args);
      audit({ tool: name, result: res?.isError ? "rejected/error" : "ok", detail: res?.content?.[0]?.text?.slice(0, 300) });
      return res;
    } catch (e) {
      audit({ tool: name, result: "exception", detail: String(e) });
      throw e;
    }
  });
};

// Tool hints for clients (readOnlyHint / destructiveHint). They are hints only; the real gate is the confirmation in confirm.ts.
type ToolHandler = (args: any) => Promise<any> | any;
const readTool = (name: string, config: any, handler: ToolHandler) => server.registerTool(name, { ...config, annotations: { readOnlyHint: true, openWorldHint: false } }, handler as any);
const localTool = (name: string, config: any, handler: ToolHandler) => server.registerTool(name, { ...config, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }, handler as any);
const safetyTool = (name: string, config: any, handler: ToolHandler) => server.registerTool(name, { ...config, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, handler as any);

readTool("get_status", { description: "Machine state: status, temperatures, axis positions, current job progress.", inputSchema: {} }, async () => {
  const [state, heat, move, job] = await Promise.all([duet.model("state"), duet.model("heat"), duet.model("move.axes"), duet.model("job")]);
  return json({
    status: state.status,
    heat: { heaters: heat.heaters, bedHeaters: heat.bedHeaters },
    axes: move,
    job: { file: job.file?.fileName, layer: job.layer, duration: job.duration, filePosition: job.filePosition, size: job.file?.size },
  });
});

readTool("get_machine_profile", { description: "Safety-relevant settings parsed from config.g (axis limits, heater max temps, motor currents). Read this before planning any motion or heating.", inputSchema: { refresh: z.boolean().optional() } }, async ({ refresh }) => json(await getProfile(refresh)));

readTool("list_files", { description: "List files in a directory on the Duet SD card, e.g. 0:/gcodes, 0:/macros, 0:/sys.", inputSchema: { dir: z.string().default("0:/gcodes") } }, async ({ dir }) => json(await duet.list(dir)));

readTool("read_file", { description: "Read a text file from the SD card (e.g. 0:/sys/config.g, 0:/macros/...). Max 200 kB.", inputSchema: { name: z.string() } }, async ({ name }) => {
  const t = redactSecrets(await duet.download(name));
  return text(t.length > 200_000 ? t.slice(0, 200_000) + "\n[truncated]" : t);
});

readTool("get_endstops", { description: "Current endstop states (triggered or not) without moving anything. Use it to check wiring by pressing each endstop by hand before homing.", inputSchema: {} }, async () => json(await duet.model("sensors.endstops")));

readTool("get_camera_snapshot", { description: `Fetch a still image from a configured camera to inspect the print or workspace. Cameras: ${Object.keys(cfg.cameras).join(", ") || "none configured (set DUET_CAMERAS or DUET_CAMERA_URL)"}.`, inputSchema: { camera: z.string().optional() } }, async ({ camera }) => {
  const names = Object.keys(cfg.cameras);
  if (!names.length) return fail("No camera configured. Set DUET_CAMERA_URL (http snapshot/MJPEG, rtsp://, dshow:<device>) or DUET_CAMERAS=\"name=url,...\".");
  const name = camera ?? names[0];
  const src = cfg.cameras[name];
  if (!src) return fail(`Unknown camera "${name}". Available: ${names.join(", ")}`);
  try {
    const f = await grabFrame(src);
    return { content: [{ type: "image" as const, data: f.data.toString("base64"), mimeType: f.mimeType }] };
  } catch (e) {
    return fail(`Camera "${name}" failed: ${(e as Error).message}`);
  }
});

readTool("list_local_cameras", { description: "List video devices on the PC running this server (DirectShow, Windows). A phone used as webcam (DroidCam, Iriun, Camo, Phone Link) appears here; use its name as DUET_CAMERAS=\"name=dshow:<device name>\".", inputSchema: {} }, async () => text(await listDshowDevices()));

localTool("preflight_gcode",
  {
    description:
      "Check a local G-code file against this machine BEFORE uploading it: print area vs axis limits, temperatures vs limits, tool selection (T0), G28 in the start block, heating before extrusion, heaters off at the end, config/firmware commands, estimated line width vs nozzle. " +
      "Read-only. With fixes (select-tool, strip-g28) it writes a patched copy next to the original (<name>.duet.gcode); the original is never modified.",
    inputSchema: {
      file: z.string().describe("Local path to a .gcode / .gco / .g file"),
      nozzle: z.number().positive().optional().describe("Nozzle diameter in mm, to judge the line width"),
      filamentDiameter: z.number().positive().optional(),
      fixes: z.array(z.enum(["select-tool", "strip-g28"])).optional(),
    },
  },
  async ({ file, nozzle, filamentDiameter, fixes }) => {
    if (!/\.(gcode|gco|g)$/i.test(file)) return fail("Only .gcode, .gco or .g files are accepted.");
    let gtext: string;
    try {
      if (statSync(file).size > 200_000_000) return fail("File is larger than 200 MB.");
      gtext = readFileSync(file, "utf8");
    } catch (e) { return fail(`Cannot read ${file}: ${(e as Error).message}`); }
    let prof: MachineProfile | undefined;
    try { prof = await getProfile(); } catch { /* Duet not reachable: analyse without machine limits */ }
    const opts = { profile: prof, maxTemp: cfg.maxTemp, nozzle, filamentDiameter };
    const report = analyzeGcode(gtext, opts);
    let out = formatReport(report, basename(file));
    if (!prof) out += "\nNote: machine limits could not be read from the Duet, so print area and limits were NOT checked.";
    if (fixes?.length) {
      const fixed = applyFixes(gtext, report, fixes);
      if (!fixed.changes.length) out += "\nNo requested fix was applicable; no file written.";
      else {
        const target = file.replace(/(\.[^.\\/]+)$/, ".duet$1");
        if (existsSync(target)) return fail(`${out}\n\nNot written: ${target} already exists. Remove or rename it first.`);
        writeFileSync(target, fixed.text);
        out += `\nPatched copy written to ${target}\n  ${fixed.changes.join("\n  ")}\nVerdict of the copy: ${analyzeGcode(fixed.text, opts).verdict.toUpperCase()}`;
      }
    }
    return text(out);
  },
);

// Emergency stop is a safe action and stays available even in read-only mode.
safetyTool("emergency_stop", { description: "M112 emergency stop. Machine must be restarted afterwards.", inputSchema: {} }, async () => text((await duet.gcode("M112")) || "M112 sent"));

const simple = (code: string) => async () => text((await duet.gcode(code)) || "ok");

const CONFIRM_NOTE = "The server asks the user itself (client dialog or system dialog); the confirm argument is ignored unless DUET_CONFIRM=model.";

control(
  "send_gcode",
  `Send G-code (max 50 lines) through the safety guard. Blocked for good: config/limit/firmware changes. Heating, resets, homing and large relative moves need the user's approval: ${CONFIRM_NOTE} Allowed macros: ${cfg.macros.join(", ") || "none"}.`,
  { gcode: z.string(), confirm: z.boolean().default(false).describe("Only honoured with DUET_CONFIRM=model") },
  async ({ gcode, confirm }) => {
    const prof = await getProfile();
    const homed = await homedMap();
    let v = checkGcode(gcode, cfg, prof, false, homed);
    if (!v.ok && v.confirmable) {
      const a = await ask("duet-mcp: confirm G-code", `Send this to the printer at ${cfg.host}?\n\n${gcode}\n\nWhy approval is needed:\n- ${v.reasons.join("\n- ")}`, confirm);
      if (!a.approved) return fail(`Not approved (${a.via}): ${a.note}. Nothing was sent. Needed approval for: ${v.reasons.join("; ")}`);
      v = checkGcode(gcode, cfg, prof, true, homed); // approved: only the hard rules remain
    }
    if (!v.ok) return fail(`Rejected by guard: ${v.reason}`);
    return text((await duet.gcode(gcode)) || "ok");
  },
);
control("pause_job", "Pause the running job (M25).", {}, simple("M25"), { destructiveHint: false });
control("resume_job", `Resume a paused job (M24). Refuses if the job was paused before the first layer or a heater is not at temperature (resume.g would extrude 10 mm into the air / cold); cancel and restart instead. With force=true the user is asked to approve resuming anyway. ${CONFIRM_NOTE}`, { force: z.boolean().default(false) }, async ({ force }) => {
  try {
    if (force) {
      const a = await ask("duet-mcp: resume anyway", `Resume the job on ${cfg.host} although the safety checks refuse it (paused before the first layer, or a heater is not at temperature)?\n\nresume.g extrudes 10 mm of filament.`, force);
      if (!a.approved) return fail(`Not approved (${a.via}): ${a.note}. The job stays paused.`);
    }
    return text(await resumeJob(duet, force));
  } catch (e) { return fail((e as Error).message); }
}, { destructiveHint: false });
control("cancel_job", "Cancel the current job. A running job is paused first (the firmware refuses M0 otherwise). Heater targets are left unchanged; the idle watchdog or send_gcode (M104/M140 S0) switches them off.", {}, async () => {
  try { return text(await cancelJob(duet)); } catch (e) { return fail((e as Error).message); }
});
control("home_axes", `Home axes with G28 (e.g. axes="XY", empty = all). Only when the machine is idle. Moves the machine until endstops trigger, so the user is asked to approve (work area clear, emergency stop within reach). ${CONFIRM_NOTE}`, { axes: z.string().regex(/^[XYZxyz]{0,3}$/).default(""), confirm: z.boolean().default(false) }, async ({ axes, confirm }) => {
  const list = orderAxes((axes || "ZXY").split(""));
  const a = await ask("duet-mcp: home axes", `Home ${list.join(", ")} on ${cfg.host}?\n\nThe machine moves until the endstops trigger. Please check: work area and bed clear, nothing in the way, emergency stop within reach.`, confirm);
  if (!a.approved) return fail(`Not approved (${a.via}): ${a.note}. The machine did not move.`);
  try {
    // One axis at a time; backs off first if an endstop is already pressed; M112 on timeout.
    return text((await homeAxes(duet, list)).join("\n"));
  } catch (e) {
    return fail((e as Error).message);
  }
});
control("start_job", `Start a G-code file from 0:/gcodes. Heats and moves the machine, so the user is asked to approve every start. ${CONFIRM_NOTE}`, { file: z.string().regex(/^[\w\-. /:]+$/), confirm: z.boolean().default(false) }, async ({ file, confirm }) => {
  const path = file.startsWith("0:/") ? file : `0:/gcodes/${file}`;
  // Pre-flight: idle machine, all linear axes homed.
  const status = await duet.model("state.status");
  if (status !== "idle") return fail(`Machine status is "${status}", not idle. Not starting.`);
  const unhomed = Object.entries(await homedMap()).filter(([, h]) => !h).map(([a]) => a);
  if (unhomed.length) return fail(`Axes not homed: ${unhomed.join(", ")}. Run home_axes first.`);
  const a = await ask("duet-mcp: start print", `Start "${path}" on ${cfg.host}?\n\nThe machine heats up and moves. Please check: bed clear and clean, filament loaded and the spool runs free, and you are present.${governor.profile.length ? `\n\nSpeed profile: ${formatSpeedProfile(governor.profile)}` : ""}`, confirm);
  if (!a.approved) return fail(`Not approved (${a.via}): ${a.note}. The print was not started.`);
  // With a speed profile the first step is sent BEFORE the job so the very first moves already run at that speed.
  const first = governor.prime();
  try {
    if (first !== undefined) await duet.gcode(`M220 S${first}`);
    return text((await duet.gcode(`M32 "${path}"`)) || `Started ${path}${first !== undefined ? ` (speed ${first} % from layer 1)` : ""}`);
  } catch (e) {
    if (first !== undefined) { governor.unprime(); await duet.gcode("M220 S100").catch(() => undefined); }
    return fail((e as Error).message);
  }
});
control("upload_file", "Upload a local file to the SD card (default dir 0:/gcodes).", { localPath: z.string(), remoteName: z.string().regex(/^[\w\-. /:]+$/).optional() }, async ({ localPath, remoteName }) => {
  const base = localPath.split(/[\\/]/).pop()!;
  const remote = remoteName ?? `0:/gcodes/${base}`;
  if (/^0:\/sys\//i.test(remote)) return fail("Uploads to 0:/sys are blocked.");
  await duet.upload(localPath, remote);
  return text(`Uploaded to ${remote}`);
});

// ---- Supervision: print rules, connection tracking and the idle-heater watchdog run inside the server,
// independent of any open chat. With DUET_READ_ONLY=true it only observes and reports; it never acts.
const supCfg = supervisorConfigFromEnv(process.env, cfg.maxTemp);
const supervisor = new JobSupervisor(supCfg);
const conn = new ConnectionTracker(Number(process.env.DUET_CONN_LOSS_SECONDS ?? 60));
const recent: SupervisorEvent[] = [];
let lastSample: Sample | undefined;

const notify = (events: SupervisorEvent[]) => {
  for (const e of events) {
    recent.push(e);
    if (recent.length > 100) recent.shift();
    audit({ tool: "supervisor", level: e.level, code: e.code, detail: e.message });
    console.error(`duet-mcp ${e.level} ${e.code}: ${e.message}`);
    server.server.sendLoggingMessage({ level: e.level === "info" ? "info" : e.level, logger: "duet-mcp", data: `${e.code}: ${e.message}` }).catch(() => undefined);
  }
};
const now = () => Date.now();

let roles: { bed: Set<number>; tool: Set<number> } | undefined;
async function collect(): Promise<Sample> {
  if (!roles) {
    const bedH: number[] = await duet.model("heat.bedHeaters").catch(() => []);
    const tools: any[] = await duet.model("tools").catch(() => []);
    roles = { bed: new Set(bedH.filter((n) => n >= 0)), tool: new Set(tools.flatMap((t) => t?.heaters ?? [])) };
  }
  const [state, heaters, job] = await Promise.all([duet.model("state"), duet.model("heat.heaters"), duet.model("job")]);
  const status: string = state.status;
  const hs: HeaterSample[] = [];
  (heaters as any[]).forEach((h, i) => {
    if (!h) return;
    hs.push({ role: roles!.bed.has(i) ? "bed" : roles!.tool.has(i) ? "tool" : "other", current: h.current, target: h.state === "active" ? h.active : h.state === "standby" ? h.standby : 0, state: h.state });
  });
  return { t: now(), status, heaters: hs, filePosition: job.filePosition ?? 0, fileSize: job.file?.size ?? 0, fileName: job.file?.fileName, layer: job.layer ?? 0, upTime: state.upTime };
}

// Speed profile per layer (M220): DUET_SPEED_PROFILE="1:30,2:50,3:80,6:100" or the set_speed_profile tool.
let initialProfile: SpeedStep[] = [];
try { initialProfile = parseSpeedProfile(process.env.DUET_SPEED_PROFILE); } catch (e) { console.error(`duet-mcp: ignoring DUET_SPEED_PROFILE: ${(e as Error).message}`); }
const governor = new SpeedGovernor(initialProfile);
const speedPct = async () => { const v = await duet.model("move.speedFactor").catch(() => undefined); return typeof v === "number" ? Math.round((v > 5 ? v : v * 100)) : undefined; };

async function runActions(actions: Action[]) {
  for (const a of actions) {
    if (cfg.readOnly) { notify([{ t: now(), level: "warning", code: "action-skipped", message: `Read-only mode: would have done "${a.type}" (${a.reason}).` }]); continue; }
    try {
      if (a.type === "pause") { if ((await duet.model("state.status")) === "processing") await duet.gcode("M25"); }
      else { await duet.gcode("M104 T0 S0"); await duet.gcode("M140 S0"); }
      audit({ tool: "supervisor-action", action: a.type, reason: a.reason });
      notify([{ t: now(), level: "warning", code: "action-done", message: `Done: ${a.type} (${a.reason}).` }]);
    } catch (e) {
      notify([{ t: now(), level: "error", code: "action-failed", message: `Could not do ${a.type} (${a.reason}): ${(e as Error).message}` }]);
    }
  }
}

const idleMinutes = Number(process.env.DUET_HEAT_IDLE_MINUTES ?? 15);
const watchdog = new HeatWatchdog(cfg.readOnly ? 0 : idleMinutes);

let failStreak = 0;
async function superviseTick(): Promise<number> {
  try {
    const s = await collect();
    failStreak = 0;
    lastSample = s;
    notify(conn.ok(s.t));
    const r = supervisor.evaluate(s);
    notify(r.events);
    await runActions(r.actions);
    const sp = governor.step({ status: s.status, layer: s.layer });
    if (sp.set !== undefined) {
      if (cfg.readOnly) notify([{ t: now(), level: "info", code: "speed-skipped", message: `Read-only mode: would set speed to ${sp.set} % (${sp.reason}).` }]);
      else {
        try {
          await duet.gcode(`M220 S${sp.set}`);
          audit({ tool: "speed-profile", percent: sp.set, reason: sp.reason });
          notify([{ t: now(), level: "info", code: "speed-set", message: `Speed factor ${sp.set} % (${sp.reason}).` }]);
        } catch (e) { notify([{ t: now(), level: "error", code: "speed-failed", message: `Could not set M220 S${sp.set}: ${(e as Error).message}` }]); }
      }
    }
    if (watchdog.tick({ status: s.status, anyTargetOn: s.heaters.some((h) => h.target > 0) }, s.t)) {
      await duet.gcode("M140 S0");
      await duet.gcode("M104 T0 S0");
      notify([{ t: now(), level: "warning", code: "idle-heaters-off", message: `Heaters were on for ${idleMinutes} min without a job; targets set to 0.` }]);
    }
    return s.status !== "idle" || s.heaters.some((h) => h.target > 0) ? pollMs : pollMs * 3; // poll gently: the Duet 2 has little RAM
  } catch (e) {
    notify(conn.fail(now(), (e as Error).message, (e as { kind?: string }).kind));
    failStreak++;
    return Math.min(pollMs * 1.5 * 2 ** (failStreak - 1), Math.max(60_000, pollMs * 1.5)); // wait longer after each failure, at most a minute
  }
}
const pollMs = Number(process.env.DUET_POLL_SECONDS ?? 10) * 1000;
if (process.env.DUET_SUPERVISOR !== "off") {
  const loop = async () => { setTimeout(loop, await superviseTick()).unref(); };
  setTimeout(loop, Math.min(2000, pollMs)).unref();
}

control(
  "set_speed_profile",
  'Set the speed profile per layer, e.g. "1:30,2:50,3:80,6:100" (from layer N on, N % speed via M220; layer 1 is the first layer) or "off". Applied by the server while a job runs, also to a job that is already running; a factor it set is reset to 100 % when the job ends. Speeds outside 10-150 % are rejected.',
  { profile: z.string() },
  async ({ profile }) => {
    try {
      governor.setProfile(parseSpeedProfile(profile));
      return text(`Speed profile: ${formatSpeedProfile(governor.profile)}`);
    } catch (e) { return fail((e as Error).message); }
  },
);

readTool("job_status",
  {
    description: "Job and supervision overview: machine status, file, layer, progress, heaters against their targets, whether the server-side supervisor is active, and its most recent events (pauses, warnings, connection problems).",
    inputSchema: { events: z.number().int().min(0).max(50).default(10) },
  },
  async ({ events }) => {
    let s: Sample;
    try {
      s = await collect();
    } catch (e) {
      // The Duet cannot be read right now: say why and still show what the supervisor saw (this is when it matters most).
      const ev = recent.slice(-events).map((x) => `  ${new Date(x.t).toISOString().slice(11, 19)} [${x.level}] ${x.code}: ${x.message}`);
      return fail([`CANNOT READ THE DUET: ${(e as Error).message}`, ev.length ? "Recent events:" : "No events recorded.", ...ev].join("\n"));
    }
    const job = await duet.model("job");
    const pct = s.fileSize ? ((s.filePosition / s.fileSize) * 100).toFixed(1) : "0";
    const lines = [
      `Status: ${s.status}${s.fileName ? ` | file ${s.fileName}` : ""}${job.layer ? ` | layer ${job.layer}` : ""} | progress ${pct} %${job.timesLeft?.file ? ` | firmware estimate ${Math.round(job.timesLeft.file / 60)} min left` : ""}`,
      ...s.heaters.map((h, i) => `Heater ${i} (${h.role}): ${h.current} C, target ${h.target} C, state ${h.state}`),
      `Speed: factor ${(await speedPct()) ?? "?"} % | profile ${formatSpeedProfile(governor.profile)}`,
      process.env.DUET_SUPERVISOR === "off"
        ? "Supervisor: OFF (DUET_SUPERVISOR=off)"
        : `Supervisor: ${cfg.readOnly ? "observe only (read-only mode, it reports but never acts)" : "ACTIVE (pauses the job / switches heaters off on problems)"}`,
    ];
    const ev = recent.slice(-events);
    lines.push(ev.length ? "Recent events:" : "No events yet.");
    for (const e of ev) lines.push(`  ${new Date(e.t).toISOString().slice(11, 19)} [${e.level}] ${e.code}: ${e.message}`);
    return text(lines.join("\n"));
  },
);

// Free the Duet's session when Claude closes the connection (the Duet 2 only has a few sessions).
const shutdown = () => duet.disconnect().finally(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.server.onclose = shutdown;
await server.connect(new StdioServerTransport());
console.error(`duet-mcp ready (host=${cfg.host}, readOnly=${cfg.readOnly})`);
