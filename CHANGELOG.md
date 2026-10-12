# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/), versions follow [SemVer](https://semver.org/). Until 1.0.0 the tools and settings may still change (alpha).

## [0.1.0] - not released yet

First version, verified on a Duet 2 WiFi (RepRapFirmware 3.2.2) with real prints.

### Added
- Read tools: status, machine profile (from `config.g`), machine info, sensors, files, endstops, camera snapshot, pre-flight check, job status.
- Control tools (opt-in with `DUET_READ_ONLY=false`): guarded `send_gcode`, `home_axes` (Z first, back-off before the endstop), `start_job`, `pause_job`, `resume_job`, `cancel_job`, `upload_file` (CRC32), `set_speed_profile`.
- Safety: G-code guard, human confirmation by the server (MCP elicitation or system dialog), supervisor, idle-heater watchdog, audit log, restart detection.
- Server instructions, 7 prompts (pre-print check, supervised print, first layer profile, bed leveling, camera check, filament change, connection problems), 4 resources.
- Simulated Duet for tests, CI on Ubuntu and Windows.
- Live cockpit on `127.0.0.1` (`DUET_VIEWER_PORT`, off by default), monitoring only (no buttons): a banner for what needs the user (approval waiting in the chat, filament change, halted, connection lost, warnings), machine and job, heaters and fans, axes and endstops as virtual LEDs, the newest camera pictures, supervisor notices. Loopback only, GET only, Host check; the page writes values as text only. The old picture gallery stays at `/pictures`.
- The pictures of a print go into a folder of their own, next to the G-code file when the assistant uploaded it; `discard_job_images` deletes them on request after the user approved.
- Periodic pictures while a job is active (`DUET_IMAGE_INTERVAL_SECONDS`, off by default, `DUET_IMAGE_AUTO_KEEP`): a timeline on the overview page without tokens; camera grabs are serialised.
- Camera picture archive: every picture handed to the assistant is saved in `./duet-mcp-images` (last 200; `DUET_IMAGE_DIR`, `DUET_IMAGE_KEEP`), named by time, camera and layer, linked in the audit log with its SHA-256 (`camera-image`), with `latest.jpg` and a self-contained overview page `index.html` (the newest 13 pictures are embedded in the page, so it works in viewers that block neighbouring files). The folder ignores itself in git.
- The start approval tells the user when a camera is configured but no picture of the bed was taken in the last 10 minutes.
- The instructions tell the assistant to look at the bed before `start_job`, to ask before `resume_job`, and that it cannot watch the machine between its answers (no promises of background polling).
- `preflight_gcode` with `filamentChangeAtLayer` writes a copy with `M600` in front of a layer (Cura and PrusaSlicer/OrcaSlicer layer markers).
- `DUET_AUDIT_READS=on` also logs the read-only tool calls.
- Tamper-evident audit log: each line carries the checksum of the previous one (`duet-mcp-verify-audit` checks it; optional `DUET_AUDIT_KEY` makes it an HMAC).
- The instructions the server sends at the start now say which cameras are configured and tell the assistant to ask about camera, bed probe, nozzle and material before the first print.
- `list_local_cameras` shows the devices with the exact `DUET_CAMERAS` line to add; the pre-print prompt asks about a bed probe and offers automatic leveling (`G29`, with approval).
- Message box of the machine (`M291`, filament change after `M600`): shown in `job_status` and as supervisor event (`message-box`, `filament-change`), answered by `acknowledge_message` after the user approved; `M292` needs approval in `send_gcode` too.
- Supervisor warns when a pause with a hot nozzle lasts too long (`long-pause-hot`, `DUET_PAUSE_HOT_MINUTES`).
- Prompt `filament_change_assistant`: the filament change in clear steps (who does what).
- Cameras: `list_cameras`, several views in one `get_camera_snapshot` call, camera notes (`DUET_CAMERA_NOTES`), picture width (`DUET_CAMERA_WIDTH`), brightness check, prompt `camera_check`, `docs/CAMERAS.md`.

### Fixed (found while testing with real prints and fresh assistants)
- `list_files` and `read_file` accept `path` as well as `dir`/`name` (an assistant listed the wrong folder silently with `path`).
- `upload_file` tries again (up to 3 times) after a transient HTTP 500 from a busy Duet.
- `M600` and `M226` are refused in `send_gcode`: sent as a command the head stays on the part with a hot nozzle. They belong inside the G-code file.
- `upload_file` with a bare file name (for example `cube.gcode`) now stores it in `0:/gcodes` (before, the Duet put it in the root directory and `start_job` did not find it). The answer shows the real path.
