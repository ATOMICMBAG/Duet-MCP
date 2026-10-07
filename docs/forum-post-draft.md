# Draft: Duet3D forum post (English)

**Title:** duet-mcp: an MCP server so AI assistants (Claude) can supervise a Duet, with safety guards – looking for testers and feedback

Hi all,

I built a small open-source server that lets an AI assistant (via the Model Context Protocol, e.g. Claude Code or Claude Desktop) talk to a Duet in standalone mode over the LAN: status, files, camera snapshot, homing, starting and supervising prints.

Because an AI should not be trusted blindly with heaters and motors, safety is the main design point:

- read-only by default; control tools need an explicit opt-in
- the human is asked for approval by the server itself (the AI cannot approve), for homing, starting a job, heating and risky G-code
- G-code guard (axis limits from your config.g, max temperatures, homed check, macro allowlist), pre-flight check of G-code files
- a supervisor that pauses on heat-up timeout, temperature deviation, no progress, board restart or lost connection
- optional first-layer speed profile (M220 per layer)
- firmware stays the first safety layer; this is a second one, not a replacement

Status: verified on one machine only (Duet 2 WiFi, RRF 3.2.2, Cartesian) with real prints. Everything else is "expected to work, untested". ~160 automated tests against a simulated Duet, CI on Ubuntu/Windows.

What I would like:

1. Testers with other boards (Duet 2 Ethernet/Maestro, Duet 3 standalone), CoreXY/Delta/Polar, newer RRF 3.4/3.5. A hardware report template is in the repo.
2. Review of the safety rules (SAFETY_RULES.md). Which cases did I miss?
3. Opinions on the name and whether it should live under a community namespace.

Repo: https://github.com/ATOMICMBAG/Duet-MCP
Please note the disclaimer in SAFETY.md: use at your own risk, supervise the machine, keep the emergency stop within reach.

Thanks for RepRapFirmware and DWC, which this builds on (the server only uses the documented HTTP API).
