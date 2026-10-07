/**
 * Speed profile per layer: percent (M220) that applies from a given layer on, e.g. "1:30,2:50,3:80,6:100".
 * Layer numbers follow the firmware (job.layer): 1 is the first layer.
 */
export interface SpeedStep { fromLayer: number; percent: number }

export function parseSpeedProfile(input: string | SpeedStep[] | null | undefined): SpeedStep[] {
  if (input === null || input === undefined) return [];
  let steps: SpeedStep[];
  if (typeof input === "string") {
    const s = input.trim();
    if (s === "" || s.toLowerCase() === "off") return [];
    steps = s.split(",").map((part) => {
      const m = part.trim().match(/^(\d+)\s*:\s*(\d+(?:\.\d+)?)\s*%?$/);
      if (!m) throw new Error(`Cannot parse "${part.trim()}". Use layer:percent pairs, e.g. 1:30,2:50,3:80,6:100`);
      return { fromLayer: +m[1], percent: +m[2] };
    });
  } else steps = input.map((x) => ({ fromLayer: x.fromLayer, percent: x.percent }));
  if (steps.length === 0) return [];
  steps.sort((a, b) => a.fromLayer - b.fromLayer);
  for (const [i, st] of steps.entries()) {
    if (!Number.isInteger(st.fromLayer) || st.fromLayer < 1) throw new Error("Layer numbers must be whole numbers starting at 1.");
    if (!(st.percent >= 10 && st.percent <= 150)) throw new Error(`Speed ${st.percent} % is outside the allowed range of 10 to 150 %.`);
    if (i > 0 && st.fromLayer === steps[i - 1].fromLayer) throw new Error(`Layer ${st.fromLayer} appears twice.`);
  }
  if (steps[0].fromLayer !== 1) steps.unshift({ fromLayer: 1, percent: 100 }); // layers before the first step run at normal speed
  return steps;
}

export const formatSpeedProfile = (p: SpeedStep[]) => (p.length ? p.map((s) => `from layer ${s.fromLayer}: ${s.percent} %`).join(", ") : "off");

export function speedFor(profile: SpeedStep[], layer: number): number | undefined {
  let out: number | undefined;
  for (const s of profile) if (layer >= s.fromLayer) out = s.percent;
  return out;
}

export interface GovernorInput { status: string; layer: number | null | undefined }
export interface GovernorResult { set?: number; reason?: string }

/**
 * Decides when to send M220. It sends only when the wanted value CHANGES (a step of the profile is reached),
 * so a speed the user changed by hand in DWC stays until the next step. When the job ends, a factor it set is reset to 100 %.
 */
export class SpeedGovernor {
  private lastWant: number | undefined;
  private applied = false;
  private wasPrinting = false;

  constructor(public profile: SpeedStep[] = []) {}

  setProfile(p: SpeedStep[]) { this.profile = p; this.lastWant = undefined; }

  /**
   * Called by start_job BEFORE the job starts: returns the speed for layer 1 (to send as M220 ahead of M32) and remembers it,
   * so the first moves already run at the profile speed instead of waiting for the first poll after the heat-up.
   */
  prime(): number | undefined {
    const first = speedFor(this.profile, 1);
    if (first === undefined) return undefined;
    this.lastWant = first;
    this.applied = true;
    return first;
  }

  /** Undo prime() when the job could not be started. */
  unprime() { this.lastWant = undefined; this.applied = false; }

  step(i: GovernorInput): GovernorResult {
    const printing = i.status === "processing";
    const paused = i.status === "paused" || i.status === "pausing" || i.status === "resuming";
    let result: GovernorResult = {};
    if (printing && i.layer && i.layer >= 1 && this.profile.length) {
      const want = speedFor(this.profile, i.layer);
      if (want !== undefined && want !== this.lastWant) {
        this.lastWant = want;
        this.applied = true;
        result = { set: want, reason: `layer ${i.layer}` };
      }
    }
    if (!printing && !paused) {
      if (this.wasPrinting && this.applied) result = { set: 100, reason: "job ended, back to 100 %" };
      if (this.wasPrinting) { this.applied = false; this.lastWant = undefined; }
    }
    this.wasPrinting = printing || paused;
    return result;
  }
}
