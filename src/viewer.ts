import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isPictureFile, mimeOf, renderIndex } from "./images.js";

/**
 * A tiny live viewer for the camera pictures (DUET_VIEWER_PORT, off by default).
 * Open http://127.0.0.1:<port>/ in a browser or in the preview pane of the desktop app: the page reloads itself, shows the newest picture and the machine state.
 * It listens on 127.0.0.1 only, answers GET on "/" and "/img/<picture file>" and nothing else, and refuses requests whose Host header is not the local address
 * (so a web page on the internet cannot read the pictures through DNS rebinding).
 */
export interface ViewerOptions {
  port: number; // 0 = pick a free port (tests)
  getDir: () => string | undefined;
  getNotes: () => Record<string, string>;
  getStatus: () => string;
}

export interface Viewer { url: string; port: number; close: () => Promise<void> }

export function startViewer(o: ViewerOptions): Promise<Viewer | undefined> {
  return new Promise((resolve) => {
    let port = o.port;
    const server = http.createServer((req, res) => {
      const send = (code: number, body: string | Buffer, type = "text/plain; charset=utf-8") => {
        res.writeHead(code, {
          "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
        });
        res.end(req.method === "HEAD" ? undefined : body);
      };
      const host = (req.headers.host ?? "").toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(403, "Forbidden");
      if (req.method !== "GET" && req.method !== "HEAD") return send(405, "Method not allowed");
      const path = (req.url ?? "/").split("?")[0];
      const dir = o.getDir();
      if (path === "/" || path === "/index.html") {
        return send(200, renderIndex(dir ?? "", o.getNotes(), new Date(), { embed: false, status: o.getStatus(), refreshSeconds: 5 }), "text/html; charset=utf-8");
      }
      const m = /^\/img\/([^/\\]+)$/.exec(path);
      if (m && dir) {
        let name: string;
        try { name = decodeURIComponent(m[1]); } catch { return send(400, "Bad request"); }
        if (isPictureFile(name) && existsSync(join(dir, name))) {
          try { return send(200, readFileSync(join(dir, name)), mimeOf(name)); } catch { /* fall through */ }
        }
      }
      return send(404, "Not found");
    });
    server.once("error", (e) => {
      console.error(`duet-mcp: the picture viewer could not start on 127.0.0.1:${port} (${(e as Error).message}). Continuing without it.`);
      resolve(undefined);
    });
    server.listen(o.port, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}/`, port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
    server.unref();
  });
}
