import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockDuet } from "./mockDuet.js";

const cleanups: (() => Promise<void>)[] = [];
export async function closeAll() { while (cleanups.length) await cleanups.pop()!(); }

export interface BootOptions {
  readOnly: boolean;
  initial?: Parameters<typeof startMockDuet>[0];
  env?: Record<string, string>;
  /** How the simulated client answers the server's confirmation questions. "none" = the client has no elicitation support. */
  elicit?: "accept" | "decline" | "none";
}

/** Starts the real server (src/index.ts) against a simulated Duet and connects an MCP client to it. */
export async function bootServer(o: BootOptions) {
  const mock = await startMockDuet(o.initial);
  const dir = mkdtempSync(join(tmpdir(), "duet-mcp-"));
  const mode = o.elicit ?? "accept";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts"],
    cwd: process.cwd(),
    env: {
      ...(process.env as Record<string, string>),
      DUET_HOST: mock.host, DUET_PASSWORD: "", DUET_READ_ONLY: String(o.readOnly),
      DUET_POLL_SECONDS: "0.2", DUET_TEMP_DEV_SECONDS: "0.6", DUET_AUDIT_LOG: join(dir, "audit.log"),
      DUET_CAMERAS: "", DUET_CAMERA_URL: "",
      DUET_CONFIRM_DIALOG: "never", // tests must never pop up a real dialog on the developer's screen
      ...o.env,
    },
    stderr: "ignore",
  });
  const prompts: string[] = [];
  const client = new Client({ name: "e2e", version: "0" }, { capabilities: mode === "none" ? {} : { elicitation: {} } });
  if (mode !== "none") {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      return mode === "decline" ? { action: "decline" as const } : { action: "accept" as const, content: { approve: true } };
    });
  }
  await client.connect(transport);
  cleanups.push(async () => { await client.close(); await mock.close(); });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, text: ((r.content as any[])[0]?.text ?? "") as string };
  };
  const status = async () => (await call("job_status", { events: 20 })).text;
  const until = async (cond: () => boolean, ms = 8000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100)); return cond(); };
  return { mock, client, call, status, until, prompts };
}
