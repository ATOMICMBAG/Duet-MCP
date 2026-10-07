import { readFileSync } from "node:fs";
import { parseCameras } from "./camera.js";

export interface Config {
  host: string;
  password: string;
  readOnly: boolean;
  cameras: Record<string, string>;
  macros: string[];
  maxTemp: { bed: number; tool: number };
}

/** Parses KEY=VALUE lines (comments with #, optional quotes). Values already present in `env` are not overwritten. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** Loads <project>/.env (git-ignored) so secrets like DUET_PASSWORD never have to be typed into chat or scripts. */
export function loadDotEnv(file = new URL("../.env", import.meta.url), env: Record<string, string | undefined> = process.env) {
  try {
    for (const [k, v] of Object.entries(parseDotEnv(readFileSync(file, "utf8")))) env[k] ??= v;
  } catch { /* no .env file: fine */ }
}

const num =(v: string | undefined, d: number) => (v && !isNaN(+v) ? +v : d);

export function loadConfig(env = process.env): Config {
  const host = env.DUET_HOST;
  if (!host) throw new Error("DUET_HOST is required (e.g. 192.168.1.50)");
  return {
    host,
    password: env.DUET_PASSWORD ?? "reprap",
    // Safe by default: control tools stay disabled until DUET_READ_ONLY=false.
    readOnly: (env.DUET_READ_ONLY ?? "true").toLowerCase() !== "false",
    cameras: parseCameras(env),
    macros: (env.DUET_MACROS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    maxTemp: { bed: num(env.DUET_MAX_BED_TEMP, 100), tool: num(env.DUET_MAX_TOOL_TEMP, 260) },
  };
}
