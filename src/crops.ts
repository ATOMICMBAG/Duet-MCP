/**
 * Named cut-outs of a camera picture that the cockpit shows next to each other, for example the filament in front of its blue strip, the spool,
 * or the LEDs of the board (to compare them with the virtual LEDs). Nothing is analysed: the page only draws the same picture twice, zoomed.
 *
 *   DUET_VIEW_CROPS="filament=bed:0.28,0.00,0.16,0.46;leds=bed:0.53,0.04,0.12,0.30"
 *   name=camera:x,y,width,height   (fractions of the picture, 0 to 1, x and y from the top left; entries separated by ";")
 */
export interface Crop { name: string; camera: string; x: number; y: number; w: number; h: number }

export function parseCrops(raw: string | undefined): Crop[] {
  const out: Crop[] = [];
  for (const part of (raw ?? "").split(";")) {
    const m = /^\s*([^=:]+?)\s*=\s*([^:]+?)\s*:\s*(.+)$/.exec(part);
    if (!m) continue;
    const nums = m[3].split(",").map((s) => Number(s.trim()));
    if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) continue;
    const [x, y, w, h] = nums;
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) continue;
    out.push({ name: m[1], camera: m[2], x, y, w, h });
    if (out.length >= 6) break; // a handful is enough, and each one is drawn again every time the picture changes
  }
  return out;
}
