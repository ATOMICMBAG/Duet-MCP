# Cameras: the most useful extra sensor

The Duet measures temperatures, positions and endstops, but it cannot see. A camera lets the AI check what the numbers cannot tell: whether the first layer really sticks, whether the part is still on the bed, whether the filament is tangled or the spool is empty. Several cheap cameras at different angles help more than one expensive one.

Tip from the Duet3D community and from semiconductor test equipment (wafer probers look at the contact point from the side, next to the chuck): **a side view at bed height shows the line where the nozzle and the part meet**, almost like a contact analysis. For a CoreXY machine the same works with a camera at head height.

## Suggested views

| View | Where | What the AI can check |
|---|---|---|
| Overview 1 and 2 | Two cameras on the machine, about -45° and +45° to the bed | Part loose or knocked over, spaghetti, bed empty and clean before the start |
| Side view | At bed height (Cartesian) or head height (CoreXY), looking along the bed | First layers (lines continuous and flat), lifting corners, nozzle touching the part, stringing |
| Close-ups of the head | 2 or 3 cameras near the print head and the part, at different angles | Material on the nozzle, layer quality, small details |
| Spool and filament path | One camera on the spool and the filament guide | Tangles, empty spool, filament change |

A single camera is fine to start with. Add the others one by one.

## Configuration

```
DUET_CAMERAS="overview=http://192.168.x.x:8080/shot.jpg,side=rtsp://192.168.x.x/stream,spool=dshow:USB Camera"
DUET_CAMERA_NOTES="overview=Overview from the front left, 45 degrees;side=Side view at bed height, shows nozzle and part contact;spool=Close-up of spool and filament path"
DUET_CAMERA_WIDTH=960
```

- Sources: `http(s)://` snapshot or MJPEG, `rtsp://`, `dshow:<device>` (Windows webcam, also a phone shown as webcam). `list_local_cameras` shows the device names.
- The notes tell the AI what each view is for; `list_cameras` shows them (without addresses, which may contain passwords). Separate notes with `;`.
- `DUET_CAMERA_WIDTH` shrinks every picture to at most this width in pixels (default 960, 0 = original). Smaller pictures cost the AI fewer tokens. This needs ffmpeg; without it the original is sent and the answer says so.
- `get_camera_snapshot` takes one name, `"all"`, or a list (at most 4) and returns each picture with its note and a brightness check (dark / ok / bright). A dark picture is reported as too dark to judge instead of guessed.
- The prompt `camera_check` guides the AI through a look at the machine with a focus (overview, first layer, nozzle contact, filament).

## Mounting advice

- **Light matters most.** Without light a camera sees nothing (the brightness check tells you). Use a steady LED inside the chamber, and avoid glare on the bed.
- **Heat and plastic:** keep cameras and cables away from the hot end and the heated bed, use a mount that does not soften (metal, or a printed mount in PETG/ABS at a safe distance), and make sure cables cannot be caught by the moving parts.
- **Stay out of the travel range:** a camera on the head side must not be hit by the head, the gantry or the bed. Check by hand with the power off.
- **A fixed, rigid mount** gives comparable pictures over time. Mark the position.
- **A contrasting background** (for example a blue strip behind the filament) makes the filament easier to see.
- **Phones** can serve as cameras (IP webcam apps) for a first try.

## What a camera is not

- A camera is **not a safety device.** It does not replace the firmware protections, a smoke detector or your own supervision (see [SAFETY.md](../SAFETY.md)).
- The AI describes what is visible and can be wrong. "Looks fine" proves nothing. The server itself does not analyse pictures or act on them. The AI may pause a job when something looks wrong (the safe direction); its instructions forbid resuming, heating or moving because of a picture alone, and every risky step still needs your approval.

## Privacy

Pictures stay on your machine: the server fetches them from your cameras, passes them to your AI client and does not store or log them. What happens to them after that depends on your AI client and provider, so do not point a camera at people or private documents. Do not post pictures publicly without checking what is in the background.
