import { readFile } from "node:fs/promises";
import { crc32 } from "./crc32.js";

export type DuetErrorKind =
  | "unsupported" // RepRapFirmware 2.x or older: no object model
  | "auth" // rr_connect err 1: password rejected
  | "busy" // rr_connect err 2: no free session
  | "unreachable" // timeout, connection refused, no route
  | "session" // HTTP 401: the session expired or the board restarted
  | "http" // any other HTTP error
  | "rejected"; // the Duet understood the request but refused the command

export class DuetError extends Error {
  constructor(public kind: DuetErrorKind, message: string) {
    super(message);
    this.name = "DuetError";
  }
}

/** One finished request, for the cockpit. `source` says who asked (set by the server, see index.ts). */
export interface RequestEvent { t: number; kind: "gcode" | "upload" | "model" | "list" | "download"; detail: string; ok: boolean; error?: string; source?: string }

export interface ClientOptions {
  retries?: number; // extra attempts for reads when the Duet is unreachable or out of sessions (default 2)
  backoffMs?: number; // first wait, doubled each time (default 1000)
  timeoutMs?: number; // per request (default 15000)
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Minimal RepRapFirmware (standalone mode) HTTP client. Requests are serialized: Duet 2 has little RAM.
 *
 * Reconnect rules:
 *  - 401 (session expired / board restarted): reconnect and repeat ONCE. The Duet rejected the request before running it, so this is safe for every call.
 *  - Unreachable or no free session: reads (model, list, download) are repeated with growing waits. Commands and uploads are NOT repeated,
 *    because after a timeout it is unknown whether the Duet already ran them.
 *  - Wrong password and rejected commands are final and reported with a clear message.
 */
export class DuetClient {
  private connected = false;
  private sessionKey: string | null = null; // newer firmware: sent as X-Session-Key so several clients on one IP do not share a session
  apiLevel = 0;
  emulated = false; // the rr_ API is emulated by DuetWebServer (single board computer mode)
  private queue: Promise<unknown> = Promise.resolve();
  private retries: number;
  private backoffMs: number;
  private timeoutMs: number;
  onRequest?: (e: RequestEvent) => void; // called once per finished request (not per retry)
  sourceOf?: () => string | undefined; // who is asking right now; read when the request is made

  constructor(private host: string, private password: string, opts: ClientOptions = {}) {
    this.retries = opts.retries ?? 2;
    this.backoffMs = opts.backoffMs ?? 1000;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  private get base() {
    return `http://${this.host}`;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async raw(path: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    const headers = new Headers(init?.headers);
    if (this.sessionKey !== null && !path.startsWith("/rr_connect")) headers.set("X-Session-Key", this.sessionKey);
    try {
      res = await fetch(this.base + path, { signal: AbortSignal.timeout(this.timeoutMs), ...init, headers });
    } catch (e) {
      const cause = (e as any)?.cause?.code ?? ((e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message);
      throw new DuetError("unreachable", `The Duet at ${this.host} is not reachable (${cause}). Is it powered, connected to the WiFi, and is its IP address still correct?`);
    }
    if (res.status === 401) throw new DuetError("session", `The Duet rejected the session (HTTP 401) for ${path.split("?")[0]}.`);
    if (!res.ok) throw new DuetError("http", `Duet HTTP ${res.status} for ${path.split("?")[0]}`);
    return res;
  }

  private async ensure() {
    if (this.connected) return;
    const time = encodeURIComponent(new Date().toISOString().slice(0, 19));
    this.sessionKey = null;
    const r = await (await this.raw(`/rr_connect?password=${encodeURIComponent(this.password)}&time=${time}&sessionKey=yes`)).json();
    if (r.err === 0 && !(r.apiLevel > 0)) {
      throw new DuetError("unsupported", `The Duet at ${this.host} runs a RepRapFirmware without object model and API level (version 2.x or older). duet-mcp needs RepRapFirmware 3.x.`);
    }
    if (r.err === 1) throw new DuetError("auth", `The Duet at ${this.host} rejected the password (rr_connect err 1). Check DUET_PASSWORD in .env. If you did not change it, the board may have restarted and loaded the password from config.g (M551).`);
    if (r.err === 2) throw new DuetError("busy", `The Duet at ${this.host} has no free session (rr_connect err 2). Close other DWC browser tabs or phone apps and try again.`);
    if (r.err !== 0) throw new DuetError("http", `rr_connect failed (err=${r.err}).`);
    this.sessionKey = r.sessionKey !== undefined && r.sessionKey !== null ? String(r.sessionKey) : null;
    this.apiLevel = r.apiLevel;
    this.emulated = r.isEmulated === true;
    this.connected = true;
  }

  private call<T>(fn: () => Promise<T>, idempotent: boolean): Promise<T> {
    return this.serial(async () => {
      let sessionRetried = false;
      let transient = 0;
      for (;;) {
        try {
          await this.ensure();
          return await fn();
        } catch (e) {
          const err = e instanceof DuetError ? e : new DuetError("http", (e as Error).message);
          if (err.kind !== "rejected") this.connected = false; // a refused command keeps a healthy session
          if (err.kind === "session" && !sessionRetried) { sessionRetried = true; continue; }
          if ((err.kind === "unreachable" || err.kind === "busy") && idempotent && transient < this.retries) {
            await wait(this.backoffMs * 2 ** transient);
            transient++;
            continue;
          }
          throw err;
        }
      }
    });
  }

  // No "f" flag: it would drop static fields (axis letter/min/max, homed) that we need.
  model(key = "", flags = "d99"): Promise<any> {
    return this.traced("model", key, () => this.call(async () => {
      const r = await this.raw(`/rr_model?key=${encodeURIComponent(key)}&flags=${flags}`);
      return (await r.json()).result;
    }, true));
  }

  /** Reports a finished request to the hook, whatever the outcome. The hook must never break a request. */
  private traced<T>(kind: RequestEvent["kind"], detail: string, run: () => Promise<T>): Promise<T> {
    const source = this.sourceOf?.();
    const report = (ok: boolean, error?: string) => { try { this.onRequest?.({ t: Date.now(), kind, detail, ok, error, source }); } catch { /* ignore */ } };
    return run().then((v) => { report(true); return v; }, (e) => { report(false, (e as Error).message); throw e; });
  }

  gcode(code: string): Promise<string> {
    return this.traced("gcode", code, () => this.gcodeRaw(code));
  }

  private gcodeRaw(code: string): Promise<string> {
    return this.call(async () => {
      await this.raw(`/rr_gcode?gcode=${encodeURIComponent(code)}`);
      // The reply buffer is read once; poll briefly for the reply to be available.
      const reply = (await (await this.raw("/rr_reply")).text()).trim();
      // A rejected command must never look like success (e.g. "M0: Pause the print before attempting to cancel it").
      if (/^Error\b/i.test(reply)) throw new DuetError("rejected", `Duet rejected "${code.split("\n")[0]}": ${reply}`);
      return reply;
    }, false);
  }

  list(dir: string): Promise<any[]> {
    return this.traced("list", dir, () => this.listRaw(dir));
  }

  private listRaw(dir: string): Promise<any[]> {
    return this.call(async () => {
      const files: any[] = [];
      let first = 0;
      for (;;) {
        const r = await (await this.raw(`/rr_filelist?dir=${encodeURIComponent(dir)}&first=${first}`)).json();
        files.push(...r.files);
        if (!r.next) return files;
        first = r.next;
      }
    }, true);
  }

  download(name: string): Promise<string> {
    return this.traced("download", name, () => this.call(async () => (await this.raw(`/rr_download?name=${encodeURIComponent(name)}`)).text(), true));
  }

  /**
   * Uploads a file with a CRC32 check. A transfer error (the checksum does not match, common on weak WiFi) is retried:
   * unlike a command, an upload can be repeated safely because it only overwrites the same file.
   */
  upload(localPath: string, remotePath: string, attempts = 3): Promise<void> {
    return this.traced("upload", remotePath, () => this.uploadRaw(localPath, remotePath, attempts));
  }

  private async uploadRaw(localPath: string, remotePath: string, attempts: number): Promise<void> {
    const body = await readFile(localPath);
    const crc = crc32(body).toString(16);
    for (let attempt = 1; ; attempt++) {
      let err = 0;
      try {
        await this.call(async () => {
          const time = encodeURIComponent(new Date().toISOString().slice(0, 19));
          const r = await (await this.raw(`/rr_upload?name=${encodeURIComponent(remotePath)}&time=${time}&crc32=${crc}`, { method: "POST", body })).json();
          err = r.err;
        }, false);
      } catch (e) {
        // The Duet answers HTTP 500 now and then when it is busy (seen on a real Duet 2 right after connecting). An upload only overwrites the same file, so trying again is safe.
        if (e instanceof DuetError && e.kind === "http" && /HTTP 5\d\d/.test(e.message) && attempt < attempts) { await wait(this.backoffMs * 2 * attempt); continue; }
        throw e;
      }
      if (err === 0) return;
      if (attempt >= attempts) throw new DuetError("rejected", `Upload of ${remotePath} failed after ${attempt} attempts (err=${err}; the checksum did not match or the SD card refused the file).`);
    }
  }

  async disconnect() {
    if (!this.connected) return;
    this.connected = false;
    const headers: Record<string, string> = this.sessionKey !== null ? { "X-Session-Key": this.sessionKey } : {};
    await fetch(`${this.base}/rr_disconnect`, { headers, signal: AbortSignal.timeout(3000) }).catch(() => undefined);
    this.sessionKey = null;
  }
}
