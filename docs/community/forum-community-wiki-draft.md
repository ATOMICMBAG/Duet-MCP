# Draft: entry for the Community Projects Wiki thread

Where: https://forum.duet3d.com/topic/14269/community-projects-wiki (post a link in that thread; the forum staff add entries). The owner posts it, best after the first release is out.

---

Hi, for the software list: **duet-mcp**, an open-source (MIT) MCP server that lets an AI assistant (Claude and other MCP clients) supervise a Duet in standalone mode over the LAN: status, files, camera pictures, homing, starting and supervising prints, a supervised filament change, and a live monitoring cockpit in the browser. Safety guards come first: read-only by default, approval by the human (asked by the server, not by the AI), a G-code guard, a supervisor that pauses on problems, a tamper-evident audit log. It uses only the documented HTTP API.

Tested so far on a Duet 2 WiFi with RRF 3.2.2 only; testers with other boards are welcome (a hardware report template is in the repo).

https://github.com/ATOMICMBAG/Duet-MCP
Discussion: https://forum.duet3d.com/topic/39518/duet-mcp-mcp-server-so-ai-assistants-claude-can-supervise-a-duet
