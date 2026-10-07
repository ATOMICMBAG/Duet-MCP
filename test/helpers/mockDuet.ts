import http from "node:http";
import type { AddressInfo } from "node:net";
import { crc32 } from "../../src/crc32.js";

/** Minimal simulated Duet (RepRapFirmware standalone HTTP API) for tests without hardware. */
export interface MockState {
  status: string;
  heaters: { current: number; active: number; standby: number; state: string }[];
  job: { layer: number; filePosition: number; file: { size: number; fileName: string } };
  gcodes: string[];
  speedFactor: number; // fraction, 1 = 100 %
  upTime: number; // seconds since boot
  password: string; // what rr_connect accepts
  connected: boolean; // is there a valid session? every endpoint except rr_connect answers 401 without one
  noSessions: boolean; // rr_connect answers err 2
  connects: number; // number of successful rr_connect calls
  nextGcodeReply: string; // reply for the next rr_reply (e.g. "Error: ...")
  files: Record<string, { name: string; size: number; type: "f" | "d"; date: string }[]>; // directory -> entries (rr_filelist)
  pageSize: number; // entries per rr_filelist answer; `next` points to the rest, like the real firmware
  uploads: Record<string, number>; // remote name -> uploaded bytes (rr_upload)
  uploadErr: number; // rr_upload answers this err code (0 = ok)
  corruptUploads: number; // the next N uploads fail the CRC32 check (simulates a bad WiFi transfer)
  uploadAttempts: number; // rr_upload requests received
  useSessionKeys: boolean; // newer firmware: rr_connect?sessionKey=yes returns a key that every later request must send as X-Session-Key
  apiLevel: number; // rr_connect apiLevel (0 = RepRapFirmware 2.x without object model)
  keys: Set<string>; // currently valid session keys
  boards: Record<string, unknown>[]; // object model "boards"
  sensors: Record<string, unknown>; // object model "sensors"
}

export async function startMockDuet(initial?: Partial<MockState>) {
  const state: MockState = {
    status: "idle",
    heaters: [{ current: 22, active: 0, standby: 0, state: "active" }, { current: 22, active: 0, standby: 0, state: "active" }],
    job: { layer: 0, filePosition: 0, file: { size: 1000, fileName: "0:/gcodes/test.gcode" } },
    gcodes: [],
    speedFactor: 1,
    upTime: 1000,
    password: "",
    connected: false,
    noSessions: false,
    connects: 0,
    nextGcodeReply: "",
    files: {},
    pageSize: 1000,
    uploads: {},
    uploadErr: 0,
    corruptUploads: 0,
    uploadAttempts: 0,
    useSessionKeys: false,
    apiLevel: 1,
    keys: new Set<string>(),
    boards: [{ name: "Duet 2 WiFi", shortName: "2WiFi", firmwareName: "RepRapFirmware for Duet 2 WiFi/Ethernet", firmwareVersion: "3.2.2" }],
    sensors: { endstops: [{ triggered: false, type: "inputPin" }], probes: [], filamentMonitors: [], analogSensors: [] },
    ...initial,
  };
  const models: Record<string, () => unknown> = {
    "state.status": () => state.status,
    state: () => ({ status: state.status, upTime: state.upTime }),
    "heat.heaters": () => state.heaters,
    "heat.bedHeaters": () => [0],
    tools: () => [{ heaters: [1] }],
    job: () => state.job,
    "move.speedFactor": () => state.speedFactor,
    boards: () => state.boards,
    sensors: () => state.sensors,
    "sensors.endstops": () => (state.sensors as any).endstops,
    "move.axes": () => ["X", "Y", "Z"].map((letter) => ({ letter, homed: true, min: 0, max: 220, machinePosition: 0 })),
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    const send = (o: unknown) => { res.setHeader("content-type", "application/json"); res.end(typeof o === "string" ? o : JSON.stringify(o)); };
    if (u.pathname === "/rr_connect") {
      if (state.noSessions) return send({ err: 2 });
      if ((u.searchParams.get("password") ?? "") !== state.password) return send({ err: 1 });
      state.connects++;
      if (state.useSessionKeys && u.searchParams.get("sessionKey") === "yes") {
        const key = String(1000000 + state.connects);
        state.keys.add(key);
        return send({ err: 0, sessionTimeout: 8000, boardType: "mock", apiLevel: state.apiLevel, sessionKey: Number(key) });
      }
      state.connected = true;
      return send({ err: 0, sessionTimeout: 8000, boardType: "mock", apiLevel: state.apiLevel });
    }
    // Authentication: with session keys every request must carry a valid X-Session-Key, otherwise the legacy "one session" flag applies.
    const keyOk = state.useSessionKeys ? state.keys.has(String(req.headers["x-session-key"] ?? "")) : state.connected;
    if (!keyOk) { res.statusCode = 401; return res.end(); }
    if (u.pathname === "/rr_disconnect") { state.keys.delete(String(req.headers["x-session-key"] ?? "")); state.connected = false; return send({ err: 0 }); }
    if (u.pathname === "/rr_model") {
      const key = u.searchParams.get("key") ?? "";
      const f = models[key];
      return send({ key, flags: u.searchParams.get("flags"), result: f ? f() : null });
    }
    if (u.pathname === "/rr_gcode") {
      const g = u.searchParams.get("gcode") ?? "";
      state.gcodes.push(g);
      if (g === "M25" && state.status === "processing") state.status = "paused";
      if (g === "M104 T0 S0") { state.heaters[1].active = 0; state.heaters[1].standby = 0; }
      if (g === "M140 S0") state.heaters[0].active = 0;
      const sf = g.match(/^M220 S(\d+(?:\.\d+)?)$/);
      if (sf) state.speedFactor = +sf[1] / 100;
      return send({ buff: 100 });
    }
    if (u.pathname === "/rr_filelist") {
      const dir = u.searchParams.get("dir") ?? "";
      const first = Number(u.searchParams.get("first") ?? 0);
      const all = state.files[dir] ?? [];
      const page = all.slice(first, first + state.pageSize);
      return send({ dir, first, files: page, next: first + state.pageSize < all.length ? first + state.pageSize : 0 });
    }
    if (u.pathname === "/rr_upload" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const name = u.searchParams.get("name") ?? "";
        const body = Buffer.concat(chunks);
        const wanted = u.searchParams.get("crc32");
        const crcOk = wanted === null || (state.corruptUploads <= 0 && Number.parseInt(wanted, 16) === crc32(body));
        if (state.corruptUploads > 0) state.corruptUploads--;
        const err = state.uploadErr !== 0 ? state.uploadErr : crcOk ? 0 : 1;
        if (err === 0) state.uploads[name] = body.length;
        state.uploadAttempts++;
        send({ err });
      });
      return;
    }
    if (u.pathname === "/rr_download") {
      res.setHeader("content-type", "text/plain");
      if (u.searchParams.get("name") === "0:/sys/config.g") {
        return res.end("; mock config.g\nM208 X0 Y0 Z0 S1\nM208 X220 Y220 Z240 S0\nM143 H0 S120\nM143 H1 S280\n");
      }
      res.statusCode = 404; return res.end();
    }
    if (u.pathname === "/rr_reply") {
      res.setHeader("content-type", "text/plain");
      const r = state.nextGcodeReply; state.nextGcodeReply = "";
      return res.end(r);
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    state,
    host: `127.0.0.1:${port}`,
    expireSession: () => { state.connected = false; state.keys.clear(); },
    close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };
}
