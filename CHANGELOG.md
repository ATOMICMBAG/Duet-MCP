# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/), versions follow [SemVer](https://semver.org/). Until 1.0.0 the tools and settings may still change (alpha).

## [Unreleased]

### Added
- Message box of the machine (`M291`, filament change after `M600`): shown in `job_status` and as supervisor event (`message-box`, `filament-change`), answered by `acknowledge_message` after the user approved; `M292` needs approval in `send_gcode` too.
- Cameras: `list_cameras`, several views in one `get_camera_snapshot` call, camera notes (`DUET_CAMERA_NOTES`), picture width (`DUET_CAMERA_WIDTH`), brightness check, prompt `camera_check`, `docs/CAMERAS.md`.

## [0.1.0] - not released yet

First version, verified on a Duet 2 WiFi (RepRapFirmware 3.2.2) with real prints.

### Added
- Read tools: status, machine profile (from `config.g`), machine info, sensors, files, endstops, camera snapshot, pre-flight check, job status.
- Control tools (opt-in with `DUET_READ_ONLY=false`): guarded `send_gcode`, `home_axes` (Z first, back-off before the endstop), `start_job`, `pause_job`, `resume_job`, `cancel_job`, `upload_file` (CRC32), `set_speed_profile`.
- Safety: G-code guard, human confirmation by the server (MCP elicitation or system dialog), supervisor, idle-heater watchdog, audit log, restart detection.
- Server instructions, 5 prompts, 4 resources.
- Simulated Duet for tests, CI on Ubuntu and Windows.
