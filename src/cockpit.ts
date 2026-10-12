import type { Sample, SupervisorEvent } from "./supervisor.js";
import { describeMessageBox, isFilamentRelated, waitsForAnswer } from "./messagebox.js";
import type { ActivityEntry } from "./activity.js";

/**
 * The data behind the cockpit page of the live viewer: what runs, what is on, what waits for the user.
 * Monitoring only: the page has no buttons, every answer and every approval stays in the chat.
 * Pure functions, no I/O; index.ts collects the input.
 */
export interface PictureInfo { file: string; time: string; camera: string; layer?: number; auto: boolean }

export interface CockpitExtra {
  axes?: { letter: string; position: number; homed: boolean }[];
  speedPct?: number;
  endstops?: { axis: string; triggered: boolean }[];
  fans?: { name: string; pct: number }[];
  error?: string; // the extra values could not be read
}

export interface CockpitInput {
  now: number;
  readOnly: boolean;
  cameras: string[];
  connection: { ok: boolean; text: string };
  sample?: Sample;
  extra?: CockpitExtra;
  pendingApproval?: { title: string; since: number };
  activity?: ActivityEntry[]; // newest first
  events: SupervisorEvent[];
  pictures?: { count: number; newest?: PictureInfo; recent: PictureInfo[] };
}

export interface Banner { level: "info" | "warning" | "error"; title: string; text: string }

const base = (name?: string) => (name ? name.split("/").pop()! : undefined);
const TWO_MINUTES = 120_000;

/** The one thing that needs the user's attention most, or null. */
export function computeBanner(i: CockpitInput): Banner | null {
  if (!i.connection.ok) return { level: "error", title: "Cannot reach the Duet", text: i.connection.text };
  const s = i.sample;
  if (s?.status === "halted") return { level: "error", title: "The machine is halted", text: "Emergency stop or firmware error. The machine needs a restart (M999) before it does anything." };
  if (i.pendingApproval) {
    const mins = Math.max(0, Math.round((i.now - i.pendingApproval.since) / 60_000));
    return { level: "warning", title: "Waiting for your approval in the chat", text: `${i.pendingApproval.title}${mins ? ` (${mins} min)` : ""}. Nothing happens until you answer the question in the chat.` };
  }
  const mb = s?.messageBox;
  if (mb && waitsForAnswer(mb)) {
    return isFilamentRelated(mb)
      ? { level: "warning", title: "Filament change: the machine waits for you", text: `${describeMessageBox(mb)}. Change the filament by hand and hurry, the nozzle is hot. Then press OK on the machine or in DWC, or tell Claude in the chat.` }
      : { level: "warning", title: "The machine shows a message and waits", text: describeMessageBox(mb) };
  }
  const recent = [...i.events].reverse().find((e) => e.level !== "info" && !["filament-change", "message-box"].includes(e.code) && i.now - e.t <= TWO_MINUTES);
  if (recent) return { level: recent.level, title: `Notice: ${recent.code}`, text: recent.message };
  if (s && (s.status === "paused" || s.status === "pausing")) {
    const tool = s.heaters.find((h) => h.role === "tool" && h.target > 0 && h.current > 150);
    return { level: "info", title: "The job is paused", text: tool ? `The nozzle is still hot (${Math.round(tool.current)} C). Do not leave the machine paused for long.` : "Continue with the chat when you are ready." };
  }
  return null;
}

export interface CockpitState {
  t: number;
  readOnly: boolean;
  connection: { ok: boolean; text: string };
  banner: Banner | null;
  machine: { status: string; job?: string; layer?: number; progressPct?: number; timeLeftMin?: number; speedPct?: number; uptimeMin?: number };
  heaters: { name: string; role: string; current: number; target: number; state: string; lit: boolean; hot: boolean }[];
  fans: { name: string; pct: number }[];
  axes: { letter: string; position: number; homed: boolean }[];
  endstops: { axis: string; triggered: boolean }[];
  pictures: { count: number; newest?: PictureInfo; recent: PictureInfo[] };
  sent: { t: number; kind: string; source: string; text: string; level: string }[]; // what the machine was sent and what was decided, newest first
  events: { t: number; level: string; code: string; message: string }[];
  hints: string[];
  extraError?: string;
}

function heaterState(role: string, current: number, target: number): string {
  if (target <= 0) return current > 50 ? "off, still hot" : "off";
  const tol = role === "bed" ? 3 : 5;
  if (current < target - tol) return "heating";
  if (current > target + tol) return "above target";
  return "holding";
}

export function buildCockpit(i: CockpitInput): CockpitState {
  const s = i.sample;
  const hints = [
    "This page only shows what is going on. Everything you answer or approve happens in the chat.",
    "Claude acts only when you write to it. The supervisor of the server watches all the time and can pause a print, but it cannot call you.",
    ...(i.readOnly ? ["The server is read-only: it cannot move, heat or print."] : []),
    ...(i.cameras.length ? [] : ["No camera is configured."]),
    "The LED dots are derived from the firmware's data, not read from the board: compare them with the camera picture.",
  ];
  return {
    t: i.now,
    readOnly: i.readOnly,
    connection: i.connection,
    banner: computeBanner(i),
    machine: {
      status: s?.status ?? "unknown",
      job: s && s.status !== "idle" ? base(s.fileName) : undefined,
      layer: s?.layer || undefined,
      progressPct: s && s.status !== "idle" && s.fileSize ? Math.round((s.filePosition / s.fileSize) * 1000) / 10 : undefined,
      timeLeftMin: s?.timeLeft && s.status !== "idle" ? Math.round(s.timeLeft / 60) : undefined,
      speedPct: i.extra?.speedPct,
      uptimeMin: s?.upTime !== undefined ? Math.round(s.upTime / 60) : undefined,
    },
    heaters: (s?.heaters ?? []).map((h, n) => ({
      name: h.role === "bed" ? "Bed" : h.role === "tool" ? "Nozzle" : `Heater ${n}`,
      role: h.role, current: Math.round(h.current * 10) / 10, target: h.target, state: h.state === "fault" ? "FAULT" : heaterState(h.role, h.current, h.target),
      lit: h.target > 0, hot: h.current > 50,
    })),
    fans: i.extra?.fans ?? [],
    axes: i.extra?.axes ?? [],
    endstops: i.extra?.endstops ?? [],
    pictures: i.pictures ?? { count: 0, recent: [] },
    sent: (i.activity ?? []).slice(0, 15).map((a) => ({ t: a.t, kind: a.kind, source: a.source, text: a.text, level: a.level })),
    events: [...i.events].slice(-8).reverse().map((e) => ({ t: e.t, level: e.level, code: e.code, message: e.message })),
    hints,
    extraError: i.extra?.error,
  };
}
