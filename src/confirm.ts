/**
 * Human confirmation that the model cannot give by itself.
 *
 * Order in "auto" mode: MCP elicitation (the client shows the question to the user) -> operating system dialog on the PC that
 * runs this server -> refuse. The model's own `confirm=true` is ignored unless DUET_CONFIRM=model (documented as unsafe).
 */
import { execFile } from "node:child_process";

export interface ConfirmRequest {
  title: string;
  message: string;
  modelConfirmed?: boolean; // the `confirm` argument the model passed; only honoured in "model" mode
}
export interface ConfirmResult { approved: boolean; via: string; note?: string }
export type ConfirmMode = "auto" | "elicit" | "dialog" | "model" | "deny";

export interface ConfirmDeps {
  mode: ConfirmMode;
  elicit?: (req: ConfirmRequest) => Promise<"accept" | "decline" | "unsupported">;
  dialog?: (req: ConfirmRequest) => Promise<"yes" | "no" | "unavailable">;
}

export const parseConfirmMode = (v: string | undefined): ConfirmMode =>
  v === "elicit" || v === "dialog" || v === "model" || v === "deny" ? v : "auto";

export function makeConfirmer(deps: ConfirmDeps): (req: ConfirmRequest) => Promise<ConfirmResult> {
  const askElicit = async (req: ConfirmRequest): Promise<ConfirmResult | "unsupported"> => {
    const r = deps.elicit ? await deps.elicit(req) : "unsupported";
    if (r === "unsupported") return "unsupported";
    return r === "accept" ? { approved: true, via: "elicitation" } : { approved: false, via: "elicitation", note: "the user declined" };
  };
  const askDialog = async (req: ConfirmRequest): Promise<ConfirmResult | "unavailable"> => {
    const r = deps.dialog ? await deps.dialog(req) : "unavailable";
    if (r === "unavailable") return "unavailable";
    return r === "yes" ? { approved: true, via: "dialog" } : { approved: false, via: "dialog", note: "the user declined (or did not answer in time)" };
  };

  return async (req) => {
    switch (deps.mode) {
      case "model":
        return req.modelConfirmed
          ? { approved: true, via: "model-flag", note: "DUET_CONFIRM=model trusts the model's confirm flag" }
          : { approved: false, via: "model-flag", note: "confirm=true is required in DUET_CONFIRM=model mode" };
      case "deny":
        return { approved: false, via: "deny", note: "DUET_CONFIRM=deny: confirmation-gated actions are switched off" };
      case "elicit": {
        const r = await askElicit(req);
        return r === "unsupported" ? { approved: false, via: "elicitation", note: "this client does not support MCP elicitation" } : r;
      }
      case "dialog": {
        const r = await askDialog(req);
        return r === "unavailable" ? { approved: false, via: "dialog", note: "no system dialog available on this machine" } : r;
      }
      default: { // auto
        const e = await askElicit(req);
        if (e !== "unsupported") return e;
        const d = await askDialog(req);
        if (d !== "unavailable") return d;
        return { approved: false, via: "none", note: "no way to ask the user: the client has no elicitation support and no system dialog is available. Use a client with elicitation, or set DUET_CONFIRM=model (unsafe)" };
      }
    }
  };
}

/** Native yes/no dialog on the PC that runs the server. The text goes through environment variables, never through a shell string. */
export function systemDialog(timeoutSeconds = 120, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env) {
  return (req: ConfirmRequest): Promise<"yes" | "no" | "unavailable"> => {
    if ((env.DUET_CONFIRM_DIALOG ?? "") === "never") return Promise.resolve("unavailable");
    const e = { ...env, DUET_DLG_TITLE: req.title, DUET_DLG_MSG: req.message };
    return new Promise((resolve) => {
      const done = (err: (Error & { code?: string | number }) | null, stdout: string) => {
        if (platform === "win32") {
          if (err && (err as any).code === "ENOENT") return resolve("unavailable");
          return resolve(stdout.trim() === "6" ? "yes" : "no"); // 6 = Yes, 7 = No, -1 = timed out
        }
        if (platform === "darwin") return err ? resolve("no") : resolve(/button returned:Yes/.test(stdout) && !/gave up:true/.test(stdout) ? "yes" : "no");
        if (err && err.code === "ENOENT") return resolve("unavailable");
        resolve(err ? "no" : "yes"); // zenity: exit 0 = yes, 1 = no, 5 = timeout
      };
      if (platform === "win32") {
        const ps = "$r = (New-Object -ComObject WScript.Shell).Popup($env:DUET_DLG_MSG, " + timeoutSeconds + ", $env:DUET_DLG_TITLE, 4 + 48 + 256 + 4096); Write-Output $r";
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { env: e, timeout: (timeoutSeconds + 15) * 1000, windowsHide: true }, (err, out) => done(err, String(out)));
      } else if (platform === "darwin") {
        const script = `display dialog (system attribute "DUET_DLG_MSG") with title (system attribute "DUET_DLG_TITLE") buttons {"No", "Yes"} default button "No" with icon caution giving up after ${timeoutSeconds}`;
        execFile("osascript", ["-e", script], { env: e, timeout: (timeoutSeconds + 15) * 1000 }, (err, out) => done(err, String(out)));
      } else {
        execFile("zenity", ["--question", "--title", req.title, "--text", req.message, "--timeout", String(timeoutSeconds)], { env: e, timeout: (timeoutSeconds + 15) * 1000 }, (err, out) => done(err, String(out)));
      }
    });
  };
}
