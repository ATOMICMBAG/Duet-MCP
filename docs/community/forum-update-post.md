# Forum update post (for the existing thread)

Where: https://forum.duet3d.com/topic/39518/duet-mcp-mcp-server-so-ai-assistants-claude-can-supervise-a-duet (reply in the thread, it brings it to the top again). Attach `pic/Duet_MCP_Claude_chat.jpg` (cockpit next to the chat) and, if the size allows, `pic/Duet_MCP_Claude_chat_visio.jpg`. The owner posts it.

Why the text is written this way: replies to the first post stayed away, so this one names a very small first step (ten minutes, nothing moves), says plainly what is tested and what is not, offers several ways to take part, and promises credit.

---

**Update: live cockpit, filament change with a message, camera timeline, and a 10-minute zero-risk test I would love your help with**

Hi all,

a short update on **duet-mcp**, the open-source MCP server that lets an AI assistant (Claude Code, Claude Desktop, or any MCP client) watch and operate a Duet in standalone mode, with the human in charge. Since my first post I have used it on real prints, and it has grown.

*(screenshot: the cockpit next to the chat)*

**What it does now**
- **Live cockpit** in your browser, on your own PC, monitoring only (no buttons): state and progress, heaters and fans, endstops as "virtual LEDs", the camera, zoomed views of the filament and the board LEDs, what was sent to the machine, and a banner when something waits for you. Handy when the PC is in the next room.
- **Filament change (M600):** the machine's "change filament, then OK" message is shown, and the assistant can answer it only after *you* approve.
- **Safety first:** read-only by default; the server (not the AI) asks you before homing, heating or starting; config, firmware and limit commands are blocked; a supervisor pauses on heat-up problems, a board restart or a lost connection; the audit log is tamper-evident. The firmware stays the first safety layer.
- **Pictures:** every picture the assistant looks at is saved per print, with an optional timeline.

**Honest status:** tested on one machine only (Duet 2 WiFi, RRF 3.2.2, Cartesian) with real prints and about 255 tests against a simulated Duet. Everything else is "expected to work". I plan to test a Duet 3 myself, but your boards and machines are what will make this useful.

**The easiest way to help (10 minutes, nothing moves, nothing heats):**
1. Install from source (see the README), put `DUET_HOST` and your password into a `.env` file, and keep `DUET_READ_ONLY=true`.
2. Ask your assistant: "Run get_machine_info and get_sensors."
3. Reply here with one line: board, firmware version, standalone or SBC, and whether it worked. "Duet 3 Mini 5+, RRF 3.6, works" is already very valuable. Please leave out IP addresses and passwords.

I will list every confirmed board in the compatibility table, with your forum name if you like.

**Not your thing? These are just as welcome:**
- Read `SAFETY_RULES.md` and tell me which case I missed.
- CoreXY, delta or polar owners: what would you check first?
- CNC, laser or robot setups on a Duet: what would an AI watcher need to be safe and useful there? Nothing is built for this yet, I would like to hear real needs first.
- Questions, criticism, "this scares me because ...": all fine.

No pressure, one-line replies are great. If you would rather not post here, use the GitHub issue template "Hardware test report" or send me a PM.

Repo: https://github.com/ATOMICMBAG/Duet-MCP (MIT, unofficial, not affiliated with Duet3D). Please read `SAFETY.md` before you connect anything that heats or moves.

Thanks to the Duet3D team for RepRapFirmware and the documented HTTP API, which this builds on.
