# Filament change with a message ("change filament, then OK")

A filament change (`M600`) is a good job for a supervised print: the machine pauses and parks, a human swaps the filament, and only then the print continues. The machine shows a **message** and waits for an **OK**. duet-mcp reads that message, tells you (event `filament-change` in `job_status`) and can answer it with `acknowledge_message`, but only after **you** have approved the question.

Nothing is changed on the machine by this server: the macro below is a file you put on the Duet yourself (Duet Web Control, System tab). The server never writes to `0:/sys`.

## Example `filament-change.g`

This is an example, **not a ready-made file**. Parking position, retract and purge lengths depend on your machine. Read every line, adapt it, and test it with the nozzle cold first. Check in the [M600 page of the Duet documentation](https://docs.duet3d.com/User_manual/Reference/Gcodes) how your firmware version runs `M600` and `filament-change.g` (and `pause.g`).

```gcode
; filament-change.g - example, ADAPT to your machine before use
M83                                   ; relative extruder moves
G1 E-3 F3600                          ; small retract
G91                                   ; relative moves
G1 Z10 F600                           ; lift the nozzle 10 mm
G90                                   ; absolute moves again
G1 X10 Y10 F6000                      ; park position: change to a free spot on YOUR machine
M291 P"Filament wechseln, dann OK druecken" R"Filament change" S2   ; waits for OK
G1 E40 F300                           ; purge the new filament
```

- `S2` makes the message wait for **OK**. With `S3` the box also offers **Cancel**; `acknowledge_message` can answer both (`action: "cancel"` only where the box has a Cancel button).
- The text can be in any language. duet-mcp treats a message as a filament change when it contains words such as filament, spool, load or unload.
- Moves after the message (purge) run when the message is answered, so only answer when the filament is really loaded.

## What happens during a print

1. `M600` (from the G-code, from the slicer, or sent as `send_gcode M600`) pauses the print and runs your macro; the machine parks.
2. The supervisor reports `filament-change`; the AI tells you.
3. You swap the filament by hand and check that it feeds.
4. You tell the AI (or answer on the machine / in DWC yourself). `acknowledge_message` asks you for approval before it sends `M292`.
5. The macro continues (purge), and the print is resumed with the usual `resume_job` (the checks of rule 23 apply).

## Things to keep in mind

- The heaters stay on while the print is paused. Do not leave the machine unattended during a filament change.
- A camera view of the spool and the filament path (see [CAMERAS.md](CAMERAS.md)) helps the AI see whether the filament is really loaded, but it is advisory only.
- Messages that ask for a **value** (numbers, text) are never answered by the server.
