import { spawn } from "node:child_process";

/**
 * Camera sources (DUET_CAMERAS="front=http://...,top=dshow:iVCam" or DUET_CAMERA_URL for a single one):
 *  - http(s)://...   JPEG snapshot (e.g. IP Webcam /shot.jpg) or MJPEG stream (first frame is taken)
 *  - rtsp://...      via ffmpeg (IP cameras, industrial cameras with RTSP)
 *  - dshow:<name>    local Windows webcam via ffmpeg, incl. a phone shown as virtual webcam (DroidCam, Iriun, Camo, Phone Link)
 */
export function parseCameras(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  if (env.DUET_CAMERA_URL) out.default = env.DUET_CAMERA_URL;
  for (const part of (env.DUET_CAMERAS ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export interface Frame { data: Buffer; mimeType: string }

function ffmpegFrame(args: string[]): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.FFMPEG_PATH || "ffmpeg", ["-loglevel", "error", ...args, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"]);
    const chunks: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => { p.kill(); reject(new Error("ffmpeg timed out")); }, 15000);
    p.stdout.on("data", (c) => chunks.push(c));
    p.stderr.on("data", (c) => (err += c));
    p.on("error", (e) => { clearTimeout(timer); reject(new Error(`ffmpeg not usable: ${e.message} (install ffmpeg or set FFMPEG_PATH)`)); });
    p.on("close", () => {
      clearTimeout(timer);
      const data = Buffer.concat(chunks);
      data.length ? resolve({ data, mimeType: "image/jpeg" }) : reject(new Error(`ffmpeg returned no image: ${err.trim().slice(0, 300)}`));
    });
  });
}

/** Read the first JPEG out of a multipart MJPEG stream. */
async function firstMjpegFrame(res: Response): Promise<Frame> {
  const reader = res.body!.getReader();
  let buf = Buffer.alloc(0);
  try {
    while (buf.length < 8_000_000) {
      const { done, value } = await reader.read();
      if (done) break;
      buf = Buffer.concat([buf, value]);
      const s = buf.indexOf(Buffer.from([0xff, 0xd8]));
      const e = s >= 0 ? buf.indexOf(Buffer.from([0xff, 0xd9]), s + 2) : -1;
      if (e >= 0) return { data: buf.subarray(s, e + 2), mimeType: "image/jpeg" };
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new Error("No JPEG frame found in MJPEG stream");
}

async function httpFrame(raw: string): Promise<Frame> {
  const u = new URL(raw);
  const headers: Record<string, string> = {};
  if (u.username) { // fetch() rejects credentials in the URL: send them as Basic auth instead
    headers.Authorization = "Basic " + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64");
    u.username = ""; u.password = "";
  }
  const res = await fetch(u, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Camera returned HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("multipart")) return firstMjpegFrame(res);
  return { data: Buffer.from(await res.arrayBuffer()), mimeType: type.split(";")[0] || "image/jpeg" };
}

export function grabFrame(source: string): Promise<Frame> {
  if (source.startsWith("dshow:")) return ffmpegFrame(["-f", "dshow", "-i", `video=${source.slice(6)}`]);
  if (source.startsWith("rtsp://")) return ffmpegFrame(["-rtsp_transport", "tcp", "-i", source]);
  return httpFrame(source);
}

/** Device names out of the ffmpeg listing: `[dshow @ ...] "Integrated Camera" (video)`. */
export function parseDshowDevices(listing: string): string[] {
  return [...listing.matchAll(/"([^"]+)"\s+\(video\)/g)].map((m) => m[1]);
}

/** The answer of list_local_cameras: the devices and the exact setting to add, because the user has to put it into .env. */
export function formatLocalCameras(listing: string): string {
  const names = parseDshowDevices(listing);
  if (!names.length) return `No video device found on this PC (DirectShow, Windows only). Network cameras need no device: use an http(s):// snapshot or an rtsp:// address in DUET_CAMERAS.\n${listing.trim().slice(0, 300)}`;
  const entries = names.map((n, i) => `${i === 0 ? "cam" : `cam${i + 1}`}=dshow:${n}`);
  return [
    `Video devices on this PC:\n${names.map((n) => `- ${n}`).join("\n")}`,
    `To use ${names.length > 1 ? "them" : "it"}, ask the user to add this to the .env file next to the server (or to the MCP registration) and restart the server:`,
    `DUET_CAMERAS="${entries.join(",")}"`,
    `Optional: DUET_CAMERA_NOTES="cam=Overview of the machine" tells the assistant what each view is for. Rename "cam" as you like.`,
  ].join("\n");
}

/** Lists Windows DirectShow video devices (ffmpeg prints them to stderr). */
export function listDshowDevices(): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]);
    let out = "";
    p.stderr.on("data", (c) => (out += c));
    p.on("error", (e) => resolve(`ffmpeg not usable: ${e.message}`));
    p.on("close", () => resolve(out.split(/\r?\n/).filter((l) => /\(video\)/.test(l)).join("\n") || out.trim()));
  });
}

/**
 * Optional description per camera, so the model knows what each view is for:
 *   DUET_CAMERA_NOTES="side=Side view at bed height, shows the nozzle touching the part;spool=Close-up of spool and filament path"
 * Entries are separated by ";".
 */
export function parseCameraNotes(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (env.DUET_CAMERA_NOTES ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(i + 1).trim()) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** What kind of source this is, without the address (it may contain a password). */
export function sourceKind(source: string): string {
  if (source.startsWith("dshow:")) return "local webcam (dshow)";
  if (source.startsWith("rtsp://")) return "RTSP stream";
  return "HTTP snapshot / MJPEG";
}

export type Brightness = "dark" | "ok" | "bright";
export function brightnessLabel(mean: number): Brightness {
  return mean < 30 ? "dark" : mean > 230 ? "bright" : "ok";
}

export interface ProcessedFrame extends Frame { brightness?: number; note?: string }

function runFfmpeg(args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.FFMPEG_PATH || "ffmpeg", ["-loglevel", "error", ...args]);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { p.kill(); reject(new Error("ffmpeg timed out")); }, 15000);
    p.stdout.on("data", (c) => chunks.push(c));
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", () => { clearTimeout(timer); const d = Buffer.concat(chunks); d.length ? resolve(d) : reject(new Error("ffmpeg returned nothing")); });
    p.stdin.on("error", () => undefined);
    p.stdin.end(input);
  });
}

/**
 * Shrinks the picture to at most `width` pixels (saves the model's tokens) and measures the mean brightness
 * (so "too dark" can be reported instead of guessed). Needs ffmpeg; without it the original is returned with a note.
 */
export async function processFrame(frame: Frame, width: number): Promise<ProcessedFrame> {
  try {
    const gray = await runFfmpeg(["-i", "pipe:0", "-vf", "scale=16:16,format=gray", "-frames:v", "1", "-f", "rawvideo", "pipe:1"], frame.data);
    const mean = gray.reduce((a, b) => a + b, 0) / gray.length;
    let data = frame.data;
    if (width > 0) data = await runFfmpeg(["-i", "pipe:0", "-vf", `scale='min(${width},iw)':-2`, "-q:v", "4", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], frame.data);
    return { data, mimeType: "image/jpeg", brightness: Math.round(mean) };
  } catch {
    return { ...frame, note: "ffmpeg not usable: picture not resized, brightness unknown" };
  }
}
