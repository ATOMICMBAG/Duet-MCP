# Roadmap

What is done, what is open, and where help is most welcome. The project is alpha: the tools and settings may still change until 1.0.0 (see [CHANGELOG.md](../CHANGELOG.md)).

## Done and verified

Verified on one machine only: **Duet 2 WiFi, RepRapFirmware 3.2.2, standalone, Cartesian printer**, with real prints, plus about 255 automated tests against a simulated Duet.

- Status, files, camera pictures, homing (Z first, backing off an endstop that is already pressed), upload with a checksum, start / pause / resume / cancel.
- Safety layer: G-code guard (limits from your `config.g`), approval by the human (asked by the server, never by the AI), supervisor (heat-up, deviation, no progress, restart, lost connection, long hot pause), idle-heater watchdog, tamper-evident audit log. See [SAFETY.md](../SAFETY.md) and [SAFETY_RULES.md](../SAFETY_RULES.md).
- Pre-flight check of G-code files, speed profile per layer, filament change (`M600`) with the machine's message ([FILAMENT_CHANGE.md](FILAMENT_CHANGE.md)).
- Cameras, picture archive and timeline, and the live cockpit ([CAMERAS.md](CAMERAS.md)).
- Tested with assistants that knew nothing about the project ([FRESH_CLAUDE_TEST.md](FRESH_CLAUDE_TEST.md)): three blind runs on the real printer; what they found was fixed.

## Where help is most welcome

1. **Other boards and firmware.** Duet 2 Ethernet / Maestro, Duet 3 in standalone mode (Mini 5+, MB6HC, MB6XD), RepRapFirmware 3.3 to 3.6 and newer. The easiest test needs 10 minutes and moves nothing: keep `DUET_READ_ONLY=true`, ask for `get_machine_info` and `get_sensors`, and report the result with the "Hardware test report" issue (no IP address, no password). The author plans to test a Duet 3 with closed-loop NEMA 23 motors himself.
2. **Other kinematics:** CoreXY, Delta, Polar. The guard asks for approval on every absolute move on non-Cartesian machines, because the XYZ box check does not apply; real feedback on homing order and limits would shape this.
3. **Review of the safety rules.** Which case did I miss? [SAFETY_RULES.md](../SAFETY_RULES.md) lists what is enforced and what is planned.
4. **CNC, laser, robot.** Duet boards run these too. What would a supervising assistant need to be safe and useful there? Ideas and real setups are welcome; nothing of this is built or tested.

## Open, in rough order

- **Single-board computer mode** (Duet 3 with a Raspberry Pi): a different API (DuetWebServer REST); needs a layer that hides the two ways of talking to the machine.
- **Resume after a restart** with `resurrect.g` / `M916`, with a mandatory reminder: the printed part must not have changed, only the head position may.
- **Bed probe and automatic leveling** (BLTouch and others): only a prompt exists (offers `G29` with approval); untested because the test machine has no probe.
- **Picture analysis** for the filament and the board LEDs: today the cockpit only shows zoomed cut-outs. Any analysis would be a hint, never a safety function.
- **Filament sensor** integration and a **PID helper**.
- **Series production ideas:** approval of the first part, piece limit, camera check per layer.
- **Tool chain** model, slicer and printer (for example OrcaSlicer's command line): would be its own project that hands a G-code file to this server.

## Not planned

- Buttons in the cockpit: it stays monitoring only; every approval stays in the chat.
- Changing the configuration, the firmware or the limits through this server: these stay with the human (`config.g`).
- Notifications to a phone: considered and left out for now; the user is expected to be near the machine.
