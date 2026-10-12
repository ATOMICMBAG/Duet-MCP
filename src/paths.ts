/**
 * Where an uploaded file ends up on the SD card. The Duet accepts a bare name and then stores it in the root directory,
 * where start_job does not look (found in the first test with a fresh assistant). So a bare name goes to 0:/gcodes.
 *   undefined          -> 0:/gcodes/<local file name>
 *   "cube.gcode"       -> 0:/gcodes/cube.gcode
 *   "macros/x.g"       -> 0:/macros/x.g
 *   "/macros/x.g"      -> 0:/macros/x.g
 *   "0:/gcodes/a.gcode" (or 1:/...) -> unchanged
 */
export function remotePath(remoteName: string | undefined, localBase: string): string {
  const n = (remoteName ?? "").trim().replace(/\\/g, "/");
  if (!n) return `0:/gcodes/${localBase}`;
  if (/^\d:\//.test(n)) return n;
  if (n.startsWith("/")) return `0:${n}`;
  if (!n.includes("/")) return `0:/gcodes/${n}`;
  return `0:/${n}`;
}
