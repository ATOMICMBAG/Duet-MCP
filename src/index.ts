#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, loadDotEnv } from "./config.js";
import { DuetClient } from "./duet.js";
import { checkGcode } from "./guard.js";
import { brightnessLabel, exclusive, formatLocalCameras, grabFrame, listDshowDevices, processFrame, sourceKind } from "./camera.js";
import { remotePath } from "./paths.js";
import { appendAudit } from "./audit.js";
import { archiveImage, discardFolder, imageSettings, isPictureFile, listPictures, stamp } from "./images.js";
import { startViewer } from "./viewer.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { ActivityLog, describeRequest } from "./activity.js";
import { QueryStats } from "./queries.js";
import { parseCrops } from "./crops.js";
import { buildCockpit, type CockpitExtra } from "./cockpit.js";
import { mergeLive, parseConfig, redactSecrets, type MachineProfile } from "./profile.js";
import { homeAxes, orderAxes } from "./homing.js";
import { describeCompat, formatCompat } from "./compat.js";
import { INSTRUCTIONS, PROMPTS, sessionFacts } from "./prompts.js";
import { makeConfirmer, parseConfirmMode, systemDialog, type ConfirmRequest } from "./confirm.js";
import { SpeedGovernor, formatSpeedProfile, parseSpeedProfile, type SpeedStep } from "./speedprofile.js";
import { cancelJob, resumeJob } from "./jobcontrol.js";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { analyzeGcode, applyFixes, formatReport } from "./preflight.js";
import { HeatWatchdog } from "./watchdog.js";
import { canAcknowledge, describeMessageBox, parseMessageBox } from "./messagebox.js";
import { ConnectionTracker, JobSupervisor, supervisorConfigFromEnv, type Action, type HeaterSample, type Sample, type SupervisorEvent } from "./supervisor.js";

// Append-only audit trail of every control action (what was asked, with which args, and what happened). Each line is chained to the one before (see audit.ts, duet-mcp-verify-audit).
const auditFile = process.env.DUET_AUDIT_LOG ?? "duet-mcp-audit.log";
const audit = (entry: Record<string, unknown>) => {
  try { appendAudit(auditFile, entry); } catch { /* never block a safety action on logging */ }
};
const homedMap = async (): Promise<Record<string, boolean>> =>
  Object.fromEntries((await duet.model("move.axes")).map((a: any) => [a.letter, !!a.homed]));

loadDotEnv();
const cfg = loadConfig();
const duet = new DuetClient(cfg.host, cfg.password);
// Who is asking right now (a tool, the supervisor ...), and a list of what was sent to the machine, for the cockpit.
const origin = new AsyncLocalStorage<{ source: string }>();
const activity = new ActivityLog();
const stats = new QueryStats();
const startedAt = Date.now();
duet.sourceOf = () => origin.getStore()?.source;
duet.onRequest = (e) => { stats.read(e); const a = describeRequest(e); if (a) activity.add(a); };
const tagged = (name: string, handler: (a: any, extra?: any) => Promise<any> | any) => (args: any, extra?: any) => { stats.tool(name); return origin.run({ source: `assistant: ${name}` }, () => handler(args, extra)); };
const server = new McpServer({ name: "duet-mcp", version: "0.1.0" }, { capabilities: { logging: {} }, instructions: INSTRUCTIONS + "\n\n" + sessionFacts({ cameras: Object.keys(cfg.cameras), readOnly: cfg.readOnly, viewerUrl: imageSettings(process.env).viewerPort && imageSettings(process.env).dir ? `http://127.0.0.1:${imageSettings(process.env).viewerPort}/` : undefined }) });

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
let pendingApproval: { title: string; since: number } | undefined; // shown in the cockpit while the user is being asked
async function ask(title: string, message: string, modelConfirmed: boolean) {
  pendingApproval = { title, since: Date.now() };
  const r = await confirmer({ title, message, modelConfirmed }).finally(() => { pendingApproval = undefined; });
  audit({ tool: "confirmation", title, approved: r.approved, via: r.via });
  activity.add({ t: Date.now(), kind: "decision", source: "you", text: r.approved ? `You approved: ${title.replace(/^duet-mcp: /, "")}` : `Not approved (${r.via}): ${title.replace(/^duet-mcp: /, "")}`, level: r.approved ? "ok" : "warn" });
  return r;
}

// Control tools are only registered when DUET_READ_ONLY=false (default: true).
const control = (name: string, description: string, inputSchema: any, handler: (a: any) => Promise<any>, annotations: Record<string, boolean> = {}) => {
  if (cfg.readOnly) return;
  server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, ...annotations } }, async (args: any) => origin.run({ source: `assistant: ${name}` }, async () => {
    stats.tool(name);
    audit({ tool: name, args });
    try {
      const res = await handler(args);
      audit({ tool: name, result: res?.isError ? "rejected/error" : "ok", detail: res?.content?.[0]?.text?.slice(0, 300) });
      return res;
    } catch (e) {
      audit({ tool: name, result: "exception", detail: String(e) });
      throw e;
    }
  }));
};

// Tool hints for clients (readOnlyHint / destructiveHint). They are hints only; the real gate is the confirmation in confirm.ts.
type ToolHandler = (args: any, extra?: any) => Promise<any> | any;
// DUET_AUDIT_READS=on also writes the read-only calls (name and arguments) to the audit log, to see what an assistant did during a test.
const journal = (name: string, handler: ToolHandler): ToolHandler => (process.env.DUET_AUDIT_READS === "on" ? (async (args: any, extra: any) => { audit({ tool: name, args, read: true }); return handler(args, extra); }) as ToolHandler : handler);
const readTool = (name: string, config: any, handler: ToolHandler) => server.registerTool(name, { ...config, annotations: { readOnlyHint: true, openWorldHint: false } }, tagged(name, journal(name, handler)) as any);
const localTool = (name: string, config: any, handler: ToolHandler) => server.registerTool(name, { ...config, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }, tagged(name, journal(name, handler)) as any);
const safetyTool = (name: string, config: any, handler: ToolHandler) => server.registerTool(name, { ...config, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, tagged(name, handler) as any);

readTool("get_status", { description: "Compact machine state: status, heaters (current/target), axes (position, homed, limits) and the current job (file, layer, progress). For events, supervisor and speed use job_status.", inputSchema: {} }, async () => {
  const [s, axes] = await Promise.all([collect(), duet.model("move.axes")]);
  return json({
    status: s.status,
    heaters: s.heaters.map((h, i) => ({ heater: i, role: h.role, current: h.current, target: h.target, state: h.state })),
    axes: (axes as any[]).map((a) => ({ letter: a.letter, position: a.machinePosition, homed: !!a.homed, min: a.min, max: a.max })),
    job: s.fileName ? { file: s.fileName, layer: s.layer, progressPercent: s.fileSize ? Math.round((s.filePosition / s.fileSize) * 1000) / 10 : 0 } : null,
  });
});

readTool("get_machine_info", { description: "Board, firmware version and how far this server has been verified against it (tested / expected / unsupported), plus uptime. Use it first to know what you are talking to.", inputSchema: {} }, async () => {
  const [boards, state] = await Promise.all([duet.model("boards"), duet.model("state")]);
  const c = describeCompat(boards, { apiLevel: duet.apiLevel, emulated: duet.emulated });
  const main = boards?.[0] ?? {};
  return text([formatCompat(c), `API level ${duet.apiLevel}, uptime ${Math.round(state?.upTime ?? 0)} s`, main.mcuTemp?.current !== undefined ? `MCU temperature ${main.mcuTemp.current} C` : "", main.vIn?.current !== undefined ? `Supply voltage ${main.vIn.current} V` : "", `Boards: ${(boards ?? []).map((b: any) => b.name ?? b.shortName).join(", ")}`].filter(Boolean).join("\n"));
});

readTool("get_sensors", { description: "Extra sensors and gadgets: probes (e.g. BLTouch), filament monitors, analog temperature sensors and endstops, as the firmware reports them. Read-only.", inputSchema: {} }, async () => {
  const s = await duet.model("sensors");
  return json({ endstops: s?.endstops ?? [], probes: s?.probes ?? [], filamentMonitors: s?.filamentMonitors ?? [], analogSensors: s?.analogSensors ?? [] });
});

readTool("get_machine_profile", { description: "Safety-relevant settings parsed from config.g (axis limits, heater max temps, motor currents). Read this before planning any motion or heating.", inputSchema: { refresh: z.boolean().optional() } }, async ({ refresh }) => json(await getProfile(refresh)));

readTool("list_files", { description: "List files in a directory on the Duet SD card, e.g. 0:/gcodes, 0:/macros, 0:/sys. Parameter dir (path is accepted too); default 0:/gcodes.", inputSchema: { dir: z.string().optional(), path: z.string().optional().describe("Same as dir") } }, async ({ dir, path }) => json(await duet.list(dir ?? path ?? "0:/gcodes")));

readTool("read_file", { description: "Read a text file from the SD card (e.g. 0:/sys/config.g, 0:/macros/...). Parameter name (path is accepted too). Max 200 kB.", inputSchema: { name: z.string().optional(), path: z.string().optional().describe("Same as name") } }, async ({ name, path }) => {
  const file = name ?? path;
  if (!file) return fail("Give the file as name, for example 0:/sys/config.g.");
  const t = redactSecrets(await duet.download(file));
  return text(t.length > 200_000 ? t.slice(0, 200_000) + "\n[truncated]" : t);
});

readTool("get_endstops", { description: "Current endstop states (triggered or not) per axis, without moving anything. Use it to check wiring by pressing each endstop by hand before homing.", inputSchema: {} }, async () => {
  const [es, axes] = await Promise.all([duet.model("sensors.endstops"), duet.model("move.axes")]);
  return json((es as any[]).map((e, i) => (e ? { axis: axes[i]?.letter ?? `#${i}`, triggered: !!e.triggered, type: e.type } : null)).filter(Boolean));
});

const cameraNames = () => Object.keys(cfg.cameras);
// Every picture handed to the assistant is archived (last 200, ./duet-mcp-images; DUET_IMAGE_DIR=off disables) and linked in the audit log.
const images = imageSettings(process.env);
let overviewShown = false;
// The pictures of a print go into a folder of their own: next to the G-code file when this session uploaded it (so they stay with the model), otherwise below the default folder.
const uploadedFrom = new Map<string, string>(); // remote base name (lower case) -> local path of the file the assistant uploaded
interface JobPictures { name: string; dir: string; active: boolean }
let jobPictures: JobPictures | undefined; // the running job, or the last one
const safeName = (s: string) => s.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "job";
function trackJobPictures(s: Sample) {
  if (!images.dir) return;
  const active = ["processing", "paused", "pausing", "resuming"].includes(s.status);
  if (active && !jobPictures?.active) {
    const base = (s.fileName ?? "job").split("/").pop()!;
    const local = uploadedFrom.get(base.toLowerCase());
    jobPictures = { name: base, dir: join(local ? join(dirname(local), "duet-mcp-images") : images.dir, `${stamp(new Date())}_${safeName(base)}`), active: true };
  } else if (!active && jobPictures?.active) jobPictures.active = false;
}
const pictureDir = () => (jobPictures?.active ? jobPictures.dir : images.dir); // where a snapshot goes right now
// The cockpit shows the newest picture there is: the folder of the current print, or if that is still empty (the print just started) the folder of the last picture that was saved, or the default folder.
let lastSavedDir: string | undefined;
const hasPictures = (d?: string) => !!d && listPictures(d).length > 0;
const viewerDir = () => [jobPictures?.dir, lastSavedDir, images.dir].find((d) => hasPictures(d)) ?? jobPictures?.dir ?? images.dir;
// When did the assistant last look at the bed? The start approval tells the human if it never did (found in a test: the first picture was taken after the start).
let lastSnapshotAt = 0;
const cameraNote = () => {
  if (!cameraNames().length) return "";
  const min = (Date.now() - lastSnapshotAt) / 60_000;
  return lastSnapshotAt && min <= 10 ? `\n\nCamera: a picture was taken ${Math.max(0, Math.round(min))} min ago.` : "\n\nCamera: configured, but NO picture of the bed was taken in the last 10 minutes. Look at the bed yourself.";
};
const cameraLabel = (n: string) => `${n} (${sourceKind(cfg.cameras[n])})${cfg.cameraNotes?.[n] ? `: ${cfg.cameraNotes[n]}` : ""}`;

readTool("list_cameras", { description: "List the configured cameras with their kind and the note that says what each view is for (for example side view at bed height, spool close-up). Addresses are not shown.", inputSchema: {} }, async () => {
  const names = cameraNames();
  return names.length ? text(names.map(cameraLabel).join("\n")) : text("No camera configured. Set DUET_CAMERAS=\"name=url,...\" and optionally DUET_CAMERA_NOTES.");
});

readTool("get_camera_snapshot", {
  description: "Fetch still images from the configured cameras to inspect the print or workspace; each picture comes with its camera note and a brightness check (dark / ok / bright). Use list_cameras to see what each view is for. Pass several names (or \"all\") to get several views in one call, at most 4. Pictures are advisory: describe what you see, never claim the print is fine, and never act on a picture alone other than pausing.",
  inputSchema: {
    camera: z.string().optional().describe("Camera name, or \"all\" for every camera (at most 4). Default: the first camera"),
    cameras: z.array(z.string()).max(4).optional().describe("Several camera names at once"),
  },
}, async ({ camera, cameras }) => {
  const names = cameraNames();
  if (!names.length) return fail("No camera configured. Set DUET_CAMERA_URL (http snapshot/MJPEG, rtsp://, dshow:<device>) or DUET_CAMERAS=\"name=url,...\".");
  let wanted: string[] = cameras?.length ? cameras : camera === "all" ? names : [camera ?? names[0]];
  if (wanted.length > 4) wanted = wanted.slice(0, 4);
  const unknown = wanted.filter((n) => !cfg.cameras[n]);
  if (unknown.length) return fail(`Unknown camera "${unknown.join('", "')}". Available: ${names.join(", ")}`);
  const content: ({ type: "image"; data: string; mimeType: string } | { type: "text"; text: string })[] = [];
  let ok = 0;
  for (const name of wanted) {
    try {
      const f = await processFrame(await exclusive(() => grabFrame(cfg.cameras[name])), cfg.cameraWidth ?? 960);
      const light = f.brightness === undefined ? (f.note ?? "brightness unknown") : `brightness ${brightnessLabel(f.brightness)} (${f.brightness}/255)`;
      let saved = "";
      if (images.dir) {
        try {
          const layer = lastSample && lastSample.status !== "idle" ? lastSample.layer : undefined;
          const a = archiveImage(pictureDir()!, images.keep, { camera: name, data: f.data, mimeType: f.mimeType, layer, notes: cfg.cameraNotes }, new Date(), images.autoKeep);
          lastSavedDir = dirname(a.path);
          audit({ tool: "camera-image", camera: name, file: a.file, dir: dirname(a.path), sha256: a.sha256, bytes: a.bytes });
          saved = `. Saved: ${a.path}${overviewShown ? "" : `. Overview page with the latest pictures: ${a.indexPath}`}`;
          overviewShown = true;
        } catch (e) { saved = `. The picture could not be saved (${(e as Error).message})`; }
      }
      content.push({ type: "text", text: `${cameraLabel(name)} - ${light}${f.brightness !== undefined && brightnessLabel(f.brightness) === "dark" ? ". Too dark to judge: say so instead of guessing" : ""}${saved}` });
      content.push({ type: "image", data: f.data.toString("base64"), mimeType: f.mimeType });
      ok++;
    } catch (e) {
      content.push({ type: "text", text: `Camera "${name}" failed: ${(e as Error).message}` });
    }
  }
  if (ok > 0) lastSnapshotAt = Date.now();
  return { content, ...(ok === 0 ? { isError: true } : {}) };
});

server.registerTool(
  "discard_job_images",
  {
    description: "Delete the camera pictures of the last print (the folder the server wrote them to). The default is to KEEP them: use this only when the user says they do not want them. The user is asked to approve first. Deletes only the server's own picture files in that folder, never anything else.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    const dir = jobPictures?.dir;
    if (!images.dir || !dir) return fail("This session has no print picture folder (pictures are off, or no print has been seen yet).");
    if (jobPictures?.active) return fail("A job is still running. Wait until it has finished.");
    const n = existsSync(dir) ? readdirSync(dir).filter(isPictureFile).length : 0;
    if (n === 0) return text(`There are no pictures in ${dir}.`);
    const a = await ask("duet-mcp: delete the pictures of the last print", `Delete ${n} camera pictures of the last print?\n\nFolder: ${dir}\n\nOnly the server's own picture files are deleted. They cannot be restored.`, false);
    if (!a.approved) return fail(`Not approved (${a.via}): ${a.note}. The pictures are kept.`);
    const r = discardFolder(dir);
    audit({ tool: "discard_job_images", dir, ...r });
    if (r.deleted === 0) return fail(`Nothing was deleted: ${dir} is not one of the server's job picture folders.`);
    return text(`Deleted ${r.deleted} files from ${dir}${r.removedFolder ? " and removed the empty folder" : r.kept ? ` (${r.kept} other files stay there)` : ""}.`);
  },
);

readTool("list_local_cameras", { description: "List video devices on the PC running this server (DirectShow, Windows). A phone used as webcam (DroidCam, Iriun, Camo, Phone Link) appears here; use its name as DUET_CAMERAS=\"name=dshow:<device name>\".", inputSchema: {} }, async () => text(formatLocalCameras(await listDshowDevices())));

localTool("preflight_gcode",
  {
    description:
      "Check a local G-code file against this machine BEFORE uploading it: print area vs axis limits, temperatures vs limits, tool selection (T0), G28 in the start block, heating before extrusion, heaters off at the end, config/firmware commands, estimated line width vs nozzle. " +
      "Read-only. With fixes (select-tool, strip-g28) or filamentChangeAtLayer it writes a patched copy next to the original (<name>.duet.gcode); the original is never modified.",
    inputSchema: {
      file: z.string().describe("Local path to a .gcode / .gco / .g file"),
      nozzle: z.number().positive().optional().describe("Nozzle diameter in mm, to judge the line width"),
      filamentDiameter: z.number().positive().optional(),
      fixes: z.array(z.enum(["select-tool", "strip-g28"])).optional(),
      filamentChangeAtLayer: z.number().int().min(2).optional().describe("Writes a patched copy with M600 (filament change) in front of this layer, counted like the firmware (1 = first layer, so at least 2). The machine needs 0:/sys/filament-change.g with real content; without it M600 does nothing useful"),
    },
  },
  async ({ file, nozzle, filamentDiameter, fixes, filamentChangeAtLayer }) => {
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
    if (fixes?.length || filamentChangeAtLayer) {
      const fixed = applyFixes(gtext, report, fixes ?? [], filamentChangeAtLayer);
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
safetyTool("emergency_stop", { description: "Emergency stop (M112): stops everything at once and switches the heaters off. The board must be restarted afterwards (power cycle, or M999 with approval). Always available, never asks for approval.", inputSchema: {} }, async () => text((await duet.gcode("M112")) || "M112 sent"));

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
    if (!v.ok) {
      activity.add({ t: Date.now(), kind: "decision", source: "assistant: send_gcode", text: `Refused by the guard: ${gcode.split("\n")[0].trim().slice(0, 60)} - ${v.reason}`, level: "warn" });
      return fail(`Rejected by guard: ${v.reason}`);
    }
    return text((await duet.gcode(gcode)) || "ok");
  },
);
control("pause_job", "Pause the running job (M25). The firmware runs pause.g (retract, lift, park) and keeps the heaters on. Continue with resume_job or end with cancel_job. Needs no approval.", {}, simple("M25"), { destructiveHint: false });
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
  const a = await ask("duet-mcp: start print", `Start "${path}" on ${cfg.host}?\n\nThe machine heats up and moves. Please check: bed clear and clean, filament loaded and the spool runs free, and you are present.${cameraNote()}${governor.profile.length ? `\n\nSpeed profile: ${formatSpeedProfile(governor.profile)}` : ""}`, confirm);
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
control("upload_file", "Upload a local file to the SD card. Without remoteName the file goes to 0:/gcodes under its own name; a bare name such as \"cube.gcode\" also goes to 0:/gcodes; for another folder give the full path (0:/macros/x.g). The answer shows where it was stored.", { localPath: z.string(), remoteName: z.string().regex(/^[\w\-. /:]+$/).optional() }, async ({ localPath, remoteName }) => {
  const base = localPath.split(/[\\/]/).pop()!;
  const remote = remotePath(remoteName, base);
  if (/^0:\/sys\//i.test(remote)) return fail("Uploads to 0:/sys are blocked.");
  await duet.upload(localPath, remote);
  uploadedFrom.set(basename(remote).toLowerCase(), resolve(localPath));
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
  return { t: now(), status, heaters: hs, filePosition: job.filePosition ?? 0, fileSize: job.file?.size ?? 0, fileName: job.file?.fileName, layer: job.layer ?? 0, upTime: state.upTime, messageBox: parseMessageBox(state.messageBox), timeLeft: typeof job.timesLeft?.file === "number" ? job.timesLeft.file : undefined };
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
      await origin.run({ source: `supervisor: ${a.type}` }, async () => {
        if (a.type === "pause") { if ((await duet.model("state.status")) === "processing") await duet.gcode("M25"); }
        else { await duet.gcode("M104 T0 S0"); await duet.gcode("M140 S0"); }
      });
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
let compatChecked = false;
const superviseTick = (): Promise<number> => origin.run({ source: "supervisor" }, superviseTickInner);
async function superviseTickInner(): Promise<number> {
  try {
    const s = await collect();
    failStreak = 0;
    if (!compatChecked) { // once: tell the user early if this board/firmware is outside what the server supports
      compatChecked = true;
      try {
        const c = describeCompat(await duet.model("boards"), { apiLevel: duet.apiLevel, emulated: duet.emulated });
        if (c.support === "unsupported" || c.support === "unknown") notify([{ t: now(), level: "warning", code: "compatibility", message: formatCompat(c).replace(/\n\s*-/g, " ·") }]);
      } catch { /* boards not readable: get_machine_info will say so */ }
    }
    lastSample = s;
    trackJobPictures(s);
    notify(conn.ok(s.t));
    const r = supervisor.evaluate(s);
    notify(r.events);
    await runActions(r.actions);
    const sp = governor.step({ status: s.status, layer: s.layer });
    if (sp.set !== undefined) {
      if (cfg.readOnly) notify([{ t: now(), level: "info", code: "speed-skipped", message: `Read-only mode: would set speed to ${sp.set} % (${sp.reason}).` }]);
      else {
        try {
          await origin.run({ source: "speed profile" }, () => duet.gcode(`M220 S${sp.set}`));
          audit({ tool: "speed-profile", percent: sp.set, reason: sp.reason });
          notify([{ t: now(), level: "info", code: "speed-set", message: `Speed factor ${sp.set} % (${sp.reason}).` }]);
        } catch (e) { notify([{ t: now(), level: "error", code: "speed-failed", message: `Could not set M220 S${sp.set}: ${(e as Error).message}` }]); }
      }
    }
    if (watchdog.tick({ status: s.status, anyTargetOn: s.heaters.some((h) => h.target > 0) }, s.t)) {
      await origin.run({ source: "idle watchdog" }, async () => { await duet.gcode("M140 S0"); await duet.gcode("M104 T0 S0"); });
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
  "acknowledge_message",
  "Answer the message box the machine is showing (state.messageBox, shown by M291, for example during a filament change after M600) with M292: action ok, or cancel where the box offers it. The firmware or a macro waits for this answer and then continues, possibly heating or extruding, so the user is asked to approve and must have done what the message says (for example loaded the new filament). " + CONFIRM_NOTE,
  { action: z.enum(["ok", "cancel"]).default("ok"), confirm: z.boolean().default(false) },
  async ({ action, confirm }) => {
    const mb = parseMessageBox(await duet.model("state.messageBox").catch(() => undefined));
    if (!mb) return fail("The machine shows no message box. Nothing to acknowledge.");
    if (!canAcknowledge(mb)) return fail(`This message cannot be answered here (${describeMessageBox(mb)}). The user has to answer it on the machine or in DWC.`);
    if (action === "cancel" && mb.mode !== 3) return fail("This message box has no Cancel button. Use action ok, or ask the user.");
    const a = await ask("duet-mcp: answer the machine's message", `The machine ${cfg.host} shows:\n${describeMessageBox(mb)}\n\nAnswer ${action === "ok" ? "OK" : "Cancel"}? Only if you did what the message asks (for example loaded the filament). The machine then continues, possibly heating and extruding.`, confirm);
    if (!a.approved) return fail(`Not approved (${a.via}): ${a.note}. The message stays open.`);
    await duet.gcode(action === "ok" ? "M292" : "M292 P1");
    return text(`Message answered with ${action}: ${describeMessageBox(mb)}`);
  },
  { destructiveHint: false },
);

// Periodic pictures while a job is active (DUET_IMAGE_INTERVAL_SECONDS, off by default): they fill the archive and the overview page
// with a timeline, even while the assistant is not asked anything. No analysis, no tokens; the assistant can look at them when the user asks.
if (images.dir && images.intervalSeconds > 0 && cameraNames().length) {
  let busy = false;
  let wasActive = false;
  let failures = 0;
  const ACTIVE = ["processing", "paused", "pausing", "resuming"];
  const timer = setInterval(async () => {
    const st = lastSample?.status;
    const active = !!st && ACTIVE.includes(st);
    const finished = wasActive && st === "idle"; // one last picture of the finished part
    wasActive = active;
    if (busy || !(active || finished)) return;
    busy = true;
    try {
      for (const name of cameraNames().slice(0, 2)) {
        try {
          const f = await processFrame(await exclusive(() => grabFrame(cfg.cameras[name])), cfg.cameraWidth ?? 960);
          const a = archiveImage(jobPictures?.dir ?? images.dir!, images.keep, { camera: name, data: f.data, mimeType: f.mimeType, layer: active ? lastSample?.layer : undefined, notes: cfg.cameraNotes, auto: true }, new Date(), images.autoKeep);
          lastSavedDir = dirname(a.path);
          audit({ tool: "camera-image", camera: name, file: a.file, dir: dirname(a.path), sha256: a.sha256, bytes: a.bytes, auto: true });
          failures = 0;
        } catch (e) {
          if (++failures === 3) notify([{ t: now(), level: "warning", code: "image-capture-failed", message: `The periodic camera picture failed 3 times in a row (${(e as Error).message}).` }]);
        }
      }
    } finally { busy = false; }
  }, images.intervalSeconds * 1000);
  timer.unref();
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
      ...(s.messageBox ? [`MESSAGE ON THE MACHINE: ${describeMessageBox(s.messageBox)}`] : []),
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

// ---- Prompts (workflow templates the user can pick) and resources (data a client can attach).
for (const p of PROMPTS) {
  const argsSchema = Object.fromEntries(Object.entries(p.args).map(([k, v]) => [k, v.optional ? z.string().optional().describe(v.description) : z.string().describe(v.description)]));
  (server as any).registerPrompt(
    p.name,
    { title: p.title, description: p.description, ...(Object.keys(argsSchema).length ? { argsSchema } : {}) },
    (args: Record<string, string | undefined> | undefined) => ({ messages: [{ role: "user", content: { type: "text", text: p.build(args ?? {}) } }] }),
  );
}
const resource = (name: string, uri: string, title: string, description: string, mimeType: string, read: () => Promise<string> | string) =>
  server.registerResource(name, uri, { title, description, mimeType }, async (u) => ({ contents: [{ uri: u.href, mimeType, text: await read() }] }));

resource("machine-profile", "duet://machine/profile", "Machine profile", "Axis limits, heater limits, motor currents and kinematics, from config.g and the live firmware values.", "application/json", async () => JSON.stringify(await getProfile(true), null, 2));
resource("config-g", "duet://machine/config.g", "config.g", "The machine's config.g from the SD card, with passwords hidden.", "text/plain", async () => redactSecrets(await duet.download("0:/sys/config.g")));
resource("server-settings", "duet://server/settings", "Server settings", "What is switched on and which limits and thresholds apply (read-only mode, confirmation mode, temperature limits, macros, cameras, supervisor, speed profile).", "application/json", () =>
  JSON.stringify({ version: "0.1.0", readOnly: cfg.readOnly, confirmMode: parseConfirmMode(process.env.DUET_CONFIRM), maxTemp: cfg.maxTemp, allowedMacros: cfg.macros, cameras: Object.keys(cfg.cameras), pictures: { folder: images.dir ?? "off", keep: images.keep, intervalSeconds: images.intervalSeconds, viewerPort: images.viewerPort ?? "off" }, supervisor: process.env.DUET_SUPERVISOR === "off" ? "off" : supCfg, idleHeaterMinutes: idleMinutes, speedProfile: formatSpeedProfile(governor.profile) }, null, 2));
resource("recent-events", "duet://events/recent", "Recent supervisor events", "The last 50 events the server noticed (job, temperature, connection, speed).", "text/plain", () =>
  recent.slice(-50).map((e) => `${new Date(e.t).toISOString()} [${e.level}] ${e.code}: ${e.message}`).join("\n") || "No events yet.");

// Data of the cockpit page: the supervisor's last sample plus a few small reads (axes, endstops, fans, speed), at most every 2.5 s and only while the page is open.
const viewCrops = parseCrops(process.env.DUET_VIEW_CROPS);
let cockpitCache: { at: number; value: unknown } | undefined;
let cockpitBusy: Promise<unknown> | undefined;
async function cockpitCollect() {
  let sample = lastSample;
  let connection = { ok: true, text: "connected" };
  const extra: CockpitExtra = {};
  try {
    if (!sample || Date.now() - sample.t > 4000) sample = await collect();
    try {
      const axes: any[] = await duet.model("move.axes");
      extra.axes = axes.filter(Boolean).map((a) => ({ letter: String(a.letter), position: Number(a.machinePosition ?? a.userPosition ?? 0), homed: !!a.homed }));
      const names = extra.axes.map((a) => a.letter);
      const es: any[] = await duet.model("sensors.endstops");
      extra.endstops = es.map((e, n) => (e ? { axis: names[n] ?? `#${n}`, triggered: !!e.triggered } : undefined)).filter((e): e is { axis: string; triggered: boolean } => !!e);
      const fans: any[] = await duet.model("fans").catch(() => []);
      extra.fans = (fans ?? []).map((f, n) => (f ? { name: String(f.name || n), pct: Math.round(Number(f.actualValue ?? f.requestedValue ?? 0) * 100) } : undefined)).filter((f): f is { name: string; pct: number } => !!f);
      extra.speedPct = await speedPct();
    } catch (e) { extra.error = (e as Error).message; }
  } catch (e) { connection = { ok: false, text: (e as Error).message }; }
  const dir = viewerDir();
  const list = dir ? listPictures(dir) : [];
  const byCamera: Record<string, (typeof list)[number]> = {};
  for (const p of list) byCamera[p.camera] ??= p; // newest first, so the first one per camera is the newest
  return buildCockpit({
    now: Date.now(), readOnly: cfg.readOnly, cameras: cameraNames(), connection, sample, extra, pendingApproval, events: recent, activity: activity.recent(15),
    queries: stats.summary(), crops: viewCrops,
    server: { version: "0.1.0", readOnly: cfg.readOnly, confirmMode: parseConfirmMode(process.env.DUET_CONFIRM), supervisor: process.env.DUET_SUPERVISOR === "off" ? "off" : cfg.readOnly ? "observes only" : "on", cameras: cameraNames().length, pictureIntervalSeconds: images.intervalSeconds, startedAt },
    pictures: { count: list.length, newest: list[0], recent: list.slice(0, 13), byCamera },
  });
}
function cockpit(): Promise<unknown> | unknown {
  if (cockpitCache && Date.now() - cockpitCache.at < 2500) return cockpitCache.value;
  cockpitBusy ??= origin.run({ source: "cockpit page" }, cockpitCollect).then((v) => { cockpitCache = { at: Date.now(), value: v }; return v; }).finally(() => { cockpitBusy = undefined; });
  return cockpitBusy;
}

// Live picture viewer (DUET_VIEWER_PORT): the page reloads itself, so it also works in the preview pane, which shows plain local files only as a still.
if (images.dir && images.viewerPort) {
  const v = await startViewer({
    port: images.viewerPort,
    getDir: viewerDir,
    getNotes: () => cfg.cameraNotes ?? {},
    getCockpit: cockpit,
    getStatus: () => {
      const s = lastSample;
      if (!s) return "No machine data yet.";
      const heat = s.heaters.map((h) => `${h.role} ${Math.round(h.current)}/${Math.round(h.target)} C`).join(", ");
      const pct = s.fileSize ? ` ${((s.filePosition / s.fileSize) * 100).toFixed(0)} %` : "";
      return `Machine: ${s.status}${s.fileName ? ` | ${s.fileName.split("/").pop()}` : ""}${s.layer ? ` | layer ${s.layer}` : ""}${s.status !== "idle" ? pct : ""} | ${heat}`;
    },
  });
  if (v) console.error(`duet-mcp: picture viewer at ${v.url}`);
}

// Free the Duet's session when Claude closes the connection (the Duet 2 only has a few sessions).
const shutdown = () => duet.disconnect().finally(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.server.onclose = shutdown;
await server.connect(new StdioServerTransport());
console.error(`duet-mcp ready (host=${cfg.host}, readOnly=${cfg.readOnly})`);
