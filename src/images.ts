import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Archive of the camera pictures that were handed to the assistant, plus a static page (index.html) to look at them.
 * Default: ./duet-mcp-images in the working folder, the last 200 pictures. DUET_IMAGE_DIR=off switches it off, DUET_IMAGE_KEEP changes the number.
 * The folder gets its own .gitignore ("*") so the pictures can never be committed by accident. Nothing here uses the network.
 */
export interface ImageSettings { dir: string | undefined; keep: number }

export function imageSettings(env: Record<string, string | undefined>, cwd = process.cwd()): ImageSettings {
  const raw = (env.DUET_IMAGE_DIR ?? "").trim();
  const keep = Number(env.DUET_IMAGE_KEEP);
  return {
    dir: /^(off|none|false|0)$/i.test(raw) ? undefined : resolve(cwd, raw || "duet-mcp-images"),
    keep: Number.isFinite(keep) && keep >= 1 ? Math.floor(keep) : 200,
  };
}

const FILE = /^(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)_([A-Za-z0-9-]+?)(?:_L(\d+))?(?:-(\d+))?\.(jpg|png|gif|webp)$/;
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export interface Archived { path: string; file: string; sha256: string; bytes: number; indexPath: string }
export interface ArchiveInput { camera: string; data: Buffer; mimeType: string; layer?: number; notes?: Record<string, string> }

interface Entry { file: string; time: string; camera: string; layer?: number }

function entries(dir: string): Entry[] {
  return readdirSync(dir)
    .map((file) => ({ file, m: FILE.exec(file) }))
    .filter((x): x is { file: string; m: RegExpExecArray } => x.m !== null)
    .map(({ file, m }) => ({ file, time: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`, camera: m[7], layer: m[8] ? Number(m[8]) : undefined }))
    .sort((a, b) => (a.file < b.file ? 1 : -1)); // newest first: the names start with the time
}

export function archiveImage(dir: string, keep: number, img: ArchiveInput, now = new Date()): Archived {
  mkdirSync(dir, { recursive: true });
  const gi = join(dir, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "# camera pictures stay out of git\n*\n");
  const camera = img.camera.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "camera";
  const ext = EXT[img.mimeType] ?? "jpg";
  const base = `${stamp(now)}_${camera}${img.layer ? `_L${img.layer}` : ""}`;
  let file = `${base}.${ext}`;
  for (let n = 2; existsSync(join(dir, file)); n++) file = `${base}-${n}.${ext}`;
  const path = join(dir, file);
  writeFileSync(path, img.data);
  copyFileSync(path, join(dir, `latest.${ext}`)); // a fixed name for editors that can show a picture and reload it
  // keep only the newest pictures; files that do not look like ours are never touched
  for (const old of entries(dir).slice(keep)) { try { unlinkSync(join(dir, old.file)); } catch { /* already gone */ } }
  const indexPath = writeIndex(dir, img.notes ?? {}, now);
  return { path, file, sha256: createHash("sha256").update(img.data).digest("hex"), bytes: img.data.length, indexPath };
}

/** The newest pictures are embedded in the page itself (data URI), so it also works where the pictures next to it cannot be loaded. */
const EMBED = 12;
const MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
function dataUri(dir: string, file: string): string | undefined {
  try { return `data:${MIME[file.split(".").pop()!] ?? "image/jpeg"};base64,${readFileSync(join(dir, file)).toString("base64")}`; } catch { return undefined; }
}

export function writeIndex(dir: string, notes: Record<string, string>, now = new Date()): string {
  const all = entries(dir);
  const caption = (e: Entry) => `${esc(e.time)} &middot; ${esc(e.camera)}${e.layer ? ` &middot; layer ${e.layer}` : ""}`;
  const cell = (e: Entry) => { const u = dataUri(dir, e.file); return `<figure>${u ? `<img src="${u}" alt="">` : ""}<figcaption>${caption(e)}</figcaption></figure>`; };
  const older = all.slice(EMBED + 1);
  const newest = all[0];
  const legend = Object.entries(notes).map(([k, v]) => `<li><b>${esc(k)}</b>: ${esc(v)}</li>`).join("");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10"><title>duet-mcp camera pictures</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1c1c1c;--mute:#666;--card:#fff;--line:#ddd}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--mute:#999;--card:#222;--line:#3a3a3a}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,sans-serif}
h1{font-size:18px;margin:0 0 4px}.mute{color:var(--mute);font-size:13px}
.big img{width:100%;max-width:960px;border:1px solid var(--line);border-radius:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-top:16px}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:6px}
figure img{width:100%;display:block;border-radius:4px}figcaption{font-size:12px;color:var(--mute);margin-top:4px}
ul{margin:6px 0 0;padding-left:18px}
</style></head><body>
<h1>duet-mcp camera pictures</h1>
<div class="mute">${all.length} pictures kept &middot; page written ${esc(stamp(now).replace("_", " ").replace(/-(\d\d)-(\d\d)$/, ":$1:$2"))} &middot; refreshes every 10 s &middot; local files only, nothing is sent anywhere</div>
${legend ? `<ul>${legend}</ul>` : ""}
${newest ? `<div class="big"><p><b>Latest</b>: ${caption(newest)}</p>${dataUri(dir, newest.file) ? `<img src="${dataUri(dir, newest.file)}" alt="latest picture">` : "<p>(picture could not be read)</p>"}</div>
<div class="grid">${all.slice(1, EMBED + 1).map(cell).join("")}</div>
${older.length ? `<p class="mute">${older.length} older pictures are in the folder <code>${esc(dir)}</code>: ${older.slice(0, 6).map((e) => esc(e.file)).join(", ")}${older.length > 6 ? ", ..." : ""}</p>` : ""}` : "<p>No pictures yet.</p>"}
</body></html>
`;
  const p = join(dir, "index.html");
  writeFileSync(p, html);
  return p;
}
