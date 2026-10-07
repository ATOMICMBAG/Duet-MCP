/**
 * Heater watchdog: if the machine sits idle (no job running) with a heater target switched on for longer
 * than `minutes`, report that the heaters should be cooled down. Only ever acts in the safe direction.
 */
export interface Sample {
  status: string; // RRF state.status
  anyTargetOn: boolean; // some heater has an active/standby target > 0
}

export class HeatWatchdog {
  private since: number | undefined;

  constructor(private minutes: number) {}

  /** Returns true when the heaters should be switched off now. */
  tick(s: Sample, now = Date.now()): boolean {
    if (this.minutes <= 0 || s.status !== "idle" || !s.anyTargetOn) {
      this.since = undefined;
      return false;
    }
    this.since ??= now;
    if (now - this.since >= this.minutes * 60_000) {
      this.since = undefined;
      return true;
    }
    return false;
  }
}
