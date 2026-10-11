# Draft: entry for the Community Projects Wiki thread

Where: https://forum.duet3d.com/topic/14269/community-projects-wiki (post a link in that thread; the forum staff add entries). The owner posts it.

---

Hi, for the software list: **duet-mcp**, an open-source (MIT) MCP server that lets an AI assistant (Claude and other MCP clients) supervise a Duet in standalone mode over the LAN: status, files, camera snapshots (several views, brightness check), homing, starting and supervising prints, with safety guards (read-only by default, human approval by the server, G-code guard, supervisor that pauses on problems). Uses only the documented HTTP API.

Tested so far on a Duet 2 WiFi with RRF 3.2.2 only; testers with other boards are welcome (hardware report template in the repo).

https://github.com/ATOMICMBAG/Duet-MCP
Discussion: https://forum.duet3d.com/topic/39518/duet-mcp-mcp-server-so-ai-assistants-claude-can-supervise-a-duet
