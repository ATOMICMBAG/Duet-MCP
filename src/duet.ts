import { readFile } from "node:fs/promises";

export type DuetErrorKind =
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
  private queue: Promise<unknown> = Promise.resolve();
  private retries: number;
  private backoffMs: number;
  private timeoutMs: number;

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
    try {
      res = await fetch(this.base + path, { signal: AbortSignal.timeout(this.timeoutMs), ...init });
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
    const r = await (await this.raw(`/rr_connect?password=${encodeURIComponent(this.password)}&time=${time}`)).json();
    if (r.err === 1) throw new DuetError("auth", `The Duet at ${this.host} rejected the password (rr_connect err 1). Check DUET_PASSWORD in .env. If you did not change it, the board may have restarted and loaded the password from config.g (M551).`);
    if (r.err === 2) throw new DuetError("busy", `The Duet at ${this.host} has no free session (rr_connect err 2). Close other DWC browser tabs or phone apps and try again.`);
    if (r.err !== 0) throw new DuetError("http", `rr_connect failed (err=${r.err}).`);
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
    return this.call(async () => {
      const r = await this.raw(`/rr_model?key=${encodeURIComponent(key)}&flags=${flags}`);
      return (await r.json()).result;
    }, true);
  }

  gcode(code: string): Promise<string> {
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
    return this.call(async () => (await this.raw(`/rr_download?name=${encodeURIComponent(name)}`)).text(), true);
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    const body = await readFile(localPath);
    await this.call(async () => {
      const time = encodeURIComponent(new Date().toISOString().slice(0, 19));
      const r = await (await this.raw(`/rr_upload?name=${encodeURIComponent(remotePath)}&time=${time}`, { method: "POST", body })).json();
      if (r.err !== 0) throw new DuetError("rejected", `Upload failed (err=${r.err})`);
    }, false);
  }

  async disconnect() {
    if (!this.connected) return;
    this.connected = false;
    await fetch(`${this.base}/rr_disconnect`).catch(() => undefined);
  }
}
