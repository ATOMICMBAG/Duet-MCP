# Safety rules of the Duet-MCP server

*Deutsch: [SAFETY_RULES.de.md](SAFETY_RULES.de.md).*

The firmware (RepRapFirmware) stays the first safety layer (heater fault monitoring, endstops, `M208` limits).
This server is the second layer. It replaces neither an emergency stop nor supervision by a person. See [SAFETY.md](SAFETY.md) for the disclaimer and the hardware requirements.

## Implemented
| # | Rule | Where |
|---|------|-------|
| 1 | Control tools are off unless `DUET_READ_ONLY` is `false` | `config.ts`, `index.ts` |
| 2 | `emergency_stop` (`M112`) is always available; `M999` needs `confirm=true` | `index.ts`, `guard.ts` |
| 3 | Configuration, firmware, network and limit commands are blocked in `send_gcode` (`M208`, `M143`, `M906`, `M92`, `M997`, `M551` ...) | `guard.ts` |
| 4 | Heating, `G28`/`G29`/`G30`/`G32`/`G92`, `M500`/`M502`, relative moves over 50 mm and `G1 H…` need the **approval of the human**: the server asks itself (elicitation or system dialog), the model's `confirm` flag is ignored. The same holds for `start_job`, `home_axes` and `resume_job` with `force` | `guard.ts`, `confirm.ts` |
| 5 | Temperature limits (bed/nozzle) apply even with `confirm=true` | `guard.ts` |
| 6 | Absolute moves are checked against the live axis limits of the firmware | `guard.ts`, `profile.ts` |
| 7 | Absolute moves on axes that are not homed are rejected | `guard.ts` |
| 8 | Macros only from the allowlist `DUET_MACROS` | `guard.ts` |
| 9 | **Back off before homing:** if an endstop is already triggered, the server first moves 5 mm away, checks that it releases, and only then approaches it. If it stays triggered, it does not home | `homing.ts` |
| 10 | Homing only in state `idle`, one axis after the other, then a `homed` check | `homing.ts` |
| 11 | A timeout while homing triggers `M112` | `homing.ts` |
| 12 | `start_job` only in state `idle` and when all axes are homed | `index.ts` |
| 13 | Uploads to `0:/sys` are blocked | `index.ts` |
| 14 | Passwords (`M551`, `M587` ...) are redacted from files that are read | `profile.ts` |
| 15 | Audit log of all control actions (`duet-mcp-audit.log`, one JSON per line) | `index.ts` |
| 16 | Requests run one after the other (a Duet 2 has little RAM and few sessions) | `duet.ts` |
| 17 | Homing order Z, X, Y (Z first, lifts the head off the bed) | `homing.ts` |
| 18 | Kinematics aware: the XYZ box is only checked for Cartesian/core*. On Delta, SCARA and Polar every absolute move needs `confirm=true` | `guard.ts`, `profile.ts` |
| 19 | Idle-heater watchdog: a heater target is set, the machine is `idle` and there is no job for longer than `DUET_HEAT_IDLE_MINUTES` (default 15, 0 = off): targets go to 0 and an audit log entry is written. It only ever acts in the safe direction | `watchdog.ts`, `index.ts` |
| 20 | Print supervisor in the server: over-temperature and heater runaway (heaters off, plus pause during a job), heater faults, temperature deviation after settling, heat-up timeout (pause), stalled progress (warning or pause) | `supervisor.ts`, `index.ts` |
| 21 | The supervisor only sends commands when `DUET_READ_ONLY=false`. Otherwise it only reports ("action skipped") | `index.ts` |
| 22 | Events (also lost connection, rejected password, job ended early) go to the audit log and to `job_status` | `index.ts` |
| 23 | `cancel_job` pauses first; `resume_job` refuses before the first layer and with a cold nozzle; replies starting with `Error` from the Duet become errors | `jobcontrol.ts`, `duet.ts` |
| 24 | Speed profile only between 10 and 150 %; the server sends `M220` only when a step changes and resets to 100 % after the job if it set the speed itself | `speedprofile.ts` |

## Planned
- A fallback for when the MCP server itself is not running (Claude closed, PC off): the Duet then keeps printing on its own. This can only be solved in the firmware (filament monitor, macros, time limits), not in the server.
- Pre-checks for series production: first-part release by the human, piece limit, camera check per layer.
- Precondition for heating: thermistor plausible (no short circuit or break), report temperature jumps.
- Filament and extrusion checks: reject very long single extrusions, leave cold extrusion to the firmware.
- Approval "for the next N minutes" instead of every action (today it asks every time).
- Resume after a restart with `resurrect.g` (`M916`), with a mandatory reminder: the printed part must not have changed, only the head position may.
