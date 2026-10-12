#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { verifyAudit } from "./audit.js";

// Usage: duet-mcp-verify-audit [file]   (default: duet-mcp-audit.log; set DUET_AUDIT_KEY if the server used one)
const file = process.argv[2] ?? process.env.DUET_AUDIT_LOG ?? "duet-mcp-audit.log";
if (!existsSync(file)) {
  console.error(`File not found: ${file}`);
  process.exit(2);
}
const r = verifyAudit(readFileSync(file, "utf8"));
console.log(`${file}: ${r.lines} lines, ${r.chained} chained, ${r.legacy} from before the chain existed.`);
if (r.chained === 0 && r.lines > 0) {
  console.log("NOT VERIFIABLE: no line carries a checksum (written before the chain existed, or not by this server).");
  process.exit(3);
}
if (r.ok) console.log("OK: the chain is intact.");
else {
  console.log(`PROBLEMS (${r.problems.length}):`);
  for (const p of r.problems) console.log(`  - ${p}`);
}
process.exit(r.ok ? 0 : 1);
