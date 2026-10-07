import type { Config } from "./config.js";
import type { MachineProfile } from "./profile.js";

/**
 * ok: true            -> may be sent
 * confirmable: true   -> would be fine with a human's approval (reasons lists everything that needs it)
 * otherwise           -> blocked for good, approval does not help
 */
export type Verdict =
  | { ok: true }
  | { ok: false; reason: string; confirmable?: false }
  | { ok: false; reason: string; confirmable: true; reasons: string[] };

// Never allowed through send_gcode: firmware/network/credential/config/limit changes. Humans do these.
export const BLOCKED = /^(M997|M552|M587|M589|M551|M28|M29|M30|M564|M143|M208|M92|M906|M907|M305|M307|M308|M584|M574|M350|M569|M566|M203|M201|M671)$/;
// Allowed only after a human approved it (see confirm.ts).
const CONFIRM = /^(M500|M502|M999|M562|M303|M80|M81|M470|M471|M120|M121|G28|G29|G30|G32|G92)$/;
const HEAT = /^(M104|M109|M140|M190|M141|M191|G10)$/;

const param = (line: string, letter: string): number | undefined => {
  const m = line.match(new RegExp(`(?:^|\\s)${letter}(-?\\d+(?:\\.\\d+)?)`, "i"));
  return m ? +m[1] : undefined;
};

/** `confirm` means "a human approved": pass false first, collect the reasons, ask, then check again with true. */
export function checkGcode(gcode: string, cfg: Config, profile: MachineProfile | undefined, confirm: boolean, homed?: Record<string, boolean>): Verdict {
  let relative = false;
  const needs = new Set<string>();
  const lines = gcode.split(/\r?\n/).map((l) => l.replace(/;.*$/, "").trim()).filter(Boolean);
  if (lines.length === 0) return { ok: false, reason: "Empty G-code" };
  if (lines.length > 50) return { ok: false, reason: "Too many lines (max 50). Upload a file and start a job instead." };

  for (const line of lines) {
    const code = line.split(/\s+/)[0].toUpperCase().replace(/^([GM])0+(\d)/, "$1$2");

    if (code === "M112") continue; // emergency stop is always allowed
    if (BLOCKED.test(code)) return { ok: false, reason: `${code} is blocked (config/firmware/limit changes must be done by a human via config.g)` };
    if (CONFIRM.test(code) && !confirm) needs.add(`${code} needs approval`);

    if (code === "M98") {
      const name = line.match(/P"?([^"\s]+)"?/i)?.[1];
      if (!name || !cfg.macros.includes(name)) return { ok: false, reason: `Macro ${name ?? "?"} is not in DUET_MACROS allowlist` };
      continue;
    }
    if (code === "G90") relative = false;
    if (code === "G91") relative = true;

    if (HEAT.test(code)) {
      const s = param(line, "S");
      const bed = code === "M140" || code === "M190";
      const max = bed ? cfg.maxTemp.bed : cfg.maxTemp.tool;
      if (s !== undefined && s > max) return { ok: false, reason: `${code} S${s} exceeds the allowed ${bed ? "bed" : "tool"} limit of ${max}°C` };
      if (s !== undefined && s > 0 && code !== "G10" && !confirm) needs.add(`heating (${code} S${s})`);
    }

    if (code === "G0" || code === "G1") {
      // G1 H1..H4 moves until an endstop/probe triggers and bypasses the usual limit checks.
      if (param(line, "H") !== undefined && !confirm) needs.add(`${code} with H (endstop/raw move)`);
      for (const axis of ["X", "Y", "Z"]) {
        const v = param(line, axis);
        if (v === undefined) continue;
        if (relative) {
          if (Math.abs(v) > 50 && !confirm) needs.add(`relative ${axis}${v} move of more than 50 mm`);
        } else {
          if (homed && homed[axis] === false && param(line, "H") === undefined) {
            return { ok: false, reason: `Axis ${axis} is not homed. Home it first (home_axes); absolute moves on unhomed axes are not trusted.` };
          }
          // The XYZ box check is only meaningful for Cartesian-like kinematics (cartesian, coreXY, coreXZ, ...).
          // Delta, SCARA, polar etc. have round or coupled work volumes: never trust the box, ask the human.
          if (profile?.kinematics && !/^(cartesian|core)/i.test(profile.kinematics) && !confirm) {
            needs.add(`absolute moves on "${profile.kinematics}" kinematics (no simple XYZ box)`);
          }
          const lim = profile?.axisLimits[axis];
          if (lim?.min !== undefined && v < lim.min) return { ok: false, reason: `${axis}${v} below axis minimum ${lim.min}` };
          if (lim?.max !== undefined && v > lim.max) return { ok: false, reason: `${axis}${v} above axis maximum ${lim.max}` };
        }
      }
    }
  }
  if (needs.size) {
    const reasons = [...needs];
    return { ok: false, confirmable: true, reasons, reason: `Needs the user's approval: ${reasons.join("; ")}` };
  }
  return { ok: true };
}
