export interface MachineProfile {
  axisLimits: Record<string, { min?: number; max?: number }>;
  heaterMaxTemp: Record<string, number>; // heater index -> max temp (M143)
  stepsPerMm: Record<string, number>;
  motorCurrent: Record<string, number>;
  raw: string[];
  kinematics?: string; // RRF kinematics name from the object model (cartesian, coreXY, delta, polar, ...)
}

const KEEP = /^(M208|M143|M92|M906|M584|M574|M350|M305|M308|M550|M453|M591)\b/i;

/** Hide passwords before file contents reach the model (M551 = DWC password; M552/M587/M588 can carry WiFi keys). */
export function redactSecrets(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => (/^\s*(M551|M552|M587|M588|M589)\b/i.test(l) ? l.replace(/"[^"]*"/g, '"***"') : l))
    .join("\n");
}

/**
 * config.g is only the starting point: M501 may load config-override.g on top of it.
 * Prefer the limits the firmware actually uses (object model move.axes / heat.heaters).
 */
export function mergeLive(p: MachineProfile, axes: any[] | undefined, heaters: any[] | undefined, kinematics?: string): MachineProfile {
  const out: MachineProfile = { ...p, axisLimits: { ...p.axisLimits }, heaterMaxTemp: { ...p.heaterMaxTemp }, kinematics };
  for (const a of axes ?? []) {
    if (typeof a?.letter === "string" && typeof a.min === "number" && typeof a.max === "number") {
      out.axisLimits[a.letter.toUpperCase()] = { min: a.min, max: a.max };
    }
  }
  (heaters ?? []).forEach((h, i) => {
    if (typeof h?.max === "number") out.heaterMaxTemp[String(i)] = h.max;
  });
  return out;
}

/** Extract safety-relevant settings from config.g (as written by the RRF Config Tool). */
export function parseConfig(text: string): MachineProfile {
  const p: MachineProfile = { axisLimits: {}, heaterMaxTemp: {}, stepsPerMm: {}, motorCurrent: {}, raw: [] };
  for (const line0 of text.split(/\r?\n/)) {
    const line = line0.replace(/;.*$/, "").trim();
    if (!KEEP.test(line)) continue;
    p.raw.push(line);
    const code = line.split(/\s+/)[0].toUpperCase();
    const params = [...line.slice(code.length).matchAll(/\b([A-Za-z])(-?\d+(?:\.\d+)?)/g)].map((m) => [m[1].toUpperCase(), +m[2]] as const);
    if (code === "M208") {
      const isMin = params.find(([k]) => k === "S")?.[1] === 1; // S1 = minima, S0 (default) = maxima
      for (const [k, v] of params) {
        if (k === "S") continue;
        const lim = (p.axisLimits[k] ??= {});
        if (isMin) lim.min = v; else lim.max = v;
      }
    } else if (code === "M143") {
      const h = params.find(([k]) => k === "H")?.[1];
      const s = params.find(([k]) => k === "S")?.[1];
      if (h !== undefined && s !== undefined) p.heaterMaxTemp[String(h)] = s;
    } else if (code === "M92" || code === "M906") {
      const target = code === "M92" ? p.stepsPerMm : p.motorCurrent;
      for (const [k, v] of params) target[k] = v;
    }
  }
  return p;
}
