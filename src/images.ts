import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/**
 * Archive of the camera pictures that were handed to the assistant, plus a static page (index.html) to look at them.
 * Default: ./duet-mcp-images in the working folder, the last 200 pictures. DUET_IMAGE_DIR=off switches it off, DUET_IMAGE_KEEP changes the number.
 * The folder gets its own .gitignore ("*") so the pictures can never be committed by accident. Nothing here uses the network.
 */
export interface ImageSettings { dir: string | undefined; keep: number; autoKeep: number; intervalSeconds: number; viewerPort: number | undefined }

export function imageSettings(env: Record<string, string | undefined>, cwd = process.cwd()): ImageSettings {
  const raw = (env.DUET_IMAGE_DIR ?? "").trim();
  const keep = Number(env.DUET_IMAGE_KEEP);
  const autoKeep = Number(env.DUET_IMAGE_AUTO_KEEP);
  const every = Number(env.DUET_IMAGE_INTERVAL_SECONDS);
  const port = Number(env.DUET_VIEWER_PORT);
  return {
    dir: /^(off|none|false|0)$/i.test(raw) ? undefined : resolve(cwd, raw || "duet-mcp-images"),
    keep: Number.isFinite(keep) && keep >= 1 ? Math.floor(keep) : 200,
    autoKeep: Number.isFinite(autoKeep) && autoKeep >= 1 ? Math.floor(autoKeep) : 300,
    intervalSeconds: Number.isFinite(every) && every > 0 ? Math.max(5, Math.floor(every)) : 0, // 0 = off; never faster than every 5 s
    viewerPort: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : undefined, // live viewer on 127.0.0.1, off by default
  };
}

const FILE = /^(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)_([A-Za-z0-9-]+?)(?:_L(\d+))?(_auto)?(?:-(\d+))?\.(jpg|png|gif|webp)$/;
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

/** The camera name as it appears in file names. */
export const cameraSlug = (s: string) => s.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "camera";

const pad = (n: number) => String(n).padStart(2, "0");
export const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export interface Archived { path: string; file: string; sha256: string; bytes: number; indexPath: string }
export interface ArchiveInput { camera: string; data: Buffer; mimeType: string; layer?: number; notes?: Record<string, string>; auto?: boolean }

interface Entry { file: string; time: string; camera: string; layer?: number; auto: boolean }

export type PictureEntry = Entry;
/** The pictures in a folder, newest first. */
export function listPictures(dir: string): Entry[] { return existsSync(dir) ? entries(dir) : []; }

function entries(dir: string): Entry[] {
  return readdirSync(dir)
    .map((file) => ({ file, m: FILE.exec(file) }))
    .filter((x): x is { file: string; m: RegExpExecArray } => x.m !== null)
    .map(({ file, m }) => ({ file, time: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`, camera: m[7], layer: m[8] ? Number(m[8]) : undefined, auto: m[9] === "_auto" }))
    .sort((a, b) => (a.file < b.file ? 1 : -1)); // newest first: the names start with the time
}

/** `keep` pictures the assistant looked at and `autoKeep` periodic pictures are kept, each counted on its own so a long print cannot push out the analysed ones. */
export function archiveImage(dir: string, keep: number, img: ArchiveInput, now = new Date(), autoKeep = 300): Archived {
  mkdirSync(dir, { recursive: true });
  const gi = join(dir, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "# camera pictures stay out of git\n*\n");
  const camera = cameraSlug(img.camera);
  const ext = EXT[img.mimeType] ?? "jpg";
  const base = `${stamp(now)}_${camera}${img.layer ? `_L${img.layer}` : ""}${img.auto ? "_auto" : ""}`;
  let file = `${base}.${ext}`;
  for (let n = 2; existsSync(join(dir, file)); n++) file = `${base}-${n}.${ext}`;
  const path = join(dir, file);
  writeFileSync(path, img.data);
  copyFileSync(path, join(dir, `latest.${ext}`)); // a fixed name for editors that can show a picture and reload it
  // keep only the newest pictures; files that do not look like ours are never touched
  const all = entries(dir);
  for (const old of [...all.filter((e) => !e.auto).slice(keep), ...all.filter((e) => e.auto).slice(autoKeep)]) { try { unlinkSync(join(dir, old.file)); } catch { /* already gone */ } }
  const indexPath = writeIndex(dir, img.notes ?? {}, now);
  return { path, file, sha256: createHash("sha256").update(img.data).digest("hex"), bytes: img.data.length, indexPath };
}

/** The newest pictures are embedded in the page itself (data URI), so it also works where the pictures next to it cannot be loaded. */
const EMBED = 12;
const MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
export const mimeOf = (file: string) => MIME[file.split(".").pop()!.toLowerCase()] ?? "image/jpeg";
function dataUri(dir: string, file: string): string | undefined {
  try { return `data:${mimeOf(file)};base64,${readFileSync(join(dir, file)).toString("base64")}`; } catch { return undefined; }
}

/** Is this a file name the server itself writes into a picture folder (a picture, latest.*)? Only such files are ever served or deleted. */
export const isPictureFile = (name: string) => FILE.test(name) || /^latest\.(jpg|png|gif|webp)$/.test(name);

export interface RenderOptions {
  embed?: boolean; // true: pictures inside the page (static file); false: <img src="img/NAME"> served by the viewer
  status?: string; // a line about the machine (live viewer only)
  refreshSeconds?: number;
}

export function renderIndex(dir: string, notes: Record<string, string>, now = new Date(), opt: RenderOptions = {}): string {
  const embed = opt.embed ?? true;
  const refresh = opt.refreshSeconds ?? 10;
  const all = existsSync(dir) ? entries(dir) : [];
  const src = (e: Entry) => (embed ? dataUri(dir, e.file) : `img/${encodeURIComponent(e.file)}`);
  const caption = (e: Entry) => `${esc(e.time)} &middot; ${esc(e.camera)}${e.layer ? ` &middot; layer ${e.layer}` : ""}${e.auto ? " &middot; auto" : ""}`;
  const cell = (e: Entry) => { const u = src(e); return `<figure>${u ? `<img src="${u}" alt="">` : ""}<figcaption>${caption(e)}</figcaption></figure>`; };
  const older = all.slice(EMBED + 1);
  const newest = all[0];
  const legend = Object.entries(notes).map(([k, v]) => `<li><b>${esc(k)}</b>: ${esc(v)}</li>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${refresh}"><title>duet-mcp camera pictures</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1c1c1c;--mute:#666;--card:#fff;--line:#ddd}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--mute:#999;--card:#222;--line:#3a3a3a}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,sans-serif}
h1{font-size:18px;margin:0 0 4px}.mute{color:var(--mute);font-size:13px}
.status{margin:8px 0;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);font-size:14px}
.big img{width:100%;max-width:960px;border:1px solid var(--line);border-radius:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-top:16px}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:6px}
figure img{width:100%;display:block;border-radius:4px}figcaption{font-size:12px;color:var(--mute);margin-top:4px}
ul{margin:6px 0 0;padding-left:18px}
</style></head><body>
<h1>duet-mcp camera pictures</h1>
<div class="mute">${all.length} pictures kept &middot; page written ${esc(stamp(now).replace("_", " ").replace(/-(\d\d)-(\d\d)$/, ":$1:$2"))} &middot; refreshes every ${refresh} s &middot; ${embed ? "local files only, nothing is sent anywhere" : "live from the local viewer (127.0.0.1)"}</div>
${opt.status ? `<div class="status">${esc(opt.status)}</div>` : ""}
${legend ? `<ul>${legend}</ul>` : ""}
${newest ? `<div class="big"><p><b>Latest</b>: ${caption(newest)}</p>${src(newest) ? `<img src="${src(newest)}" alt="latest picture">` : "<p>(picture could not be read)</p>"}</div>
<div class="grid">${all.slice(1, EMBED + 1).map(cell).join("")}</div>
${older.length ? `<p class="mute">${older.length} older pictures are in the folder <code>${esc(dir)}</code>: ${older.slice(0, 6).map((e) => esc(e.file)).join(", ")}${older.length > 6 ? ", ..." : ""}</p>` : ""}` : "<p>No pictures yet.</p>"}
</body></html>
`;
}

export function writeIndex(dir: string, notes: Record<string, string>, now = new Date()): string {
  const p = join(dir, "index.html");
  writeFileSync(p, renderIndex(dir, notes, now, { embed: true }));
  return p;
}

/**
 * Deletes the pictures of one folder: only files the server writes (pictures, latest.*, index.html, its .gitignore) and the folder itself if it is empty afterwards.
 * Anything else in the folder stays. The folder must look like one of the server's own job folders (its name starts with the time stamp, `2026-10-12_17-43-07_name`).
 */
export function discardFolder(dir: string): { deleted: number; kept: number; removedFolder: boolean } {
  if (!/^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_/.test(basename(dir)) || !existsSync(dir)) return { deleted: 0, kept: 0, removedFolder: false };
  let deleted = 0, kept = 0;
  for (const f of readdirSync(dir)) {
    if (isPictureFile(f) || f === "index.html" || f === ".gitignore") { try { unlinkSync(join(dir, f)); deleted++; } catch { kept++; } }
    else kept++;
  }
  let removedFolder = false;
  if (kept === 0) { try { rmdirSync(dir); removedFolder = true; } catch { /* not empty */ } }
  return { deleted, kept, removedFolder };
}
