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
- **The bed may hide the part.** On a printer whose bed moves back at the end (Y bed, like the author's), a camera in front of the machine no longer sees the finished part: it disappears behind the gantry. Place a camera that sees the bed in its rear position as well (from the side or from above), or take the last picture before the end G-code moves the bed.
- **Phones** can serve as cameras (IP webcam apps) for a first try.

## What a camera is not

- A camera is **not a safety device.** It does not replace the firmware protections, a smoke detector or your own supervision (see [SAFETY.md](../SAFETY.md)).
- The AI describes what is visible and can be wrong. "Looks fine" proves nothing. The server itself does not analyse pictures or act on them. The AI may pause a job when something looks wrong (the safe direction); its instructions forbid resuming, heating or moving because of a picture alone, and every risky step still needs your approval.

## Saved pictures and the overview page

Every picture that `get_camera_snapshot` hands to the assistant is also **saved** in the folder `duet-mcp-images` in the working folder of the server (the folder where you started your client), as `2026-10-12_17-43-07_bed_L4.jpg` (time, camera, layer while a job runs). Why: so you can see what the assistant looked at, and so the audit log can name the exact picture: each save is a line `camera-image` with the file name and the SHA-256 of the picture (the log is hash-chained, see [SAFETY_RULES.md](../SAFETY_RULES.md) rule 15).

- The newest **200** pictures are kept, older ones are deleted (`DUET_IMAGE_KEEP`). Files in the folder that do not follow the naming scheme are never touched.
- `latest.jpg` always holds the newest picture, and `index.html` is a **static overview page**: the latest picture large, the next 12 below with time, camera and layer, older ones listed by name, refreshed every 10 seconds. The newest pictures are **embedded in the page itself**, so it also works where the files next to it cannot be loaded (the desktop app's preview pane shows a local file outside the project folder as a static snapshot and blocks pictures and links next to it; this is why the first version showed no picture). It uses local files only, no network.
- The folder has its own `.gitignore` (`*`), so the pictures cannot be committed by accident.
- Switch it off with `DUET_IMAGE_DIR=off`, or choose another folder with `DUET_IMAGE_DIR=<path>`.

### One folder per print

While a job runs, its pictures go into a folder of their own, named after the time and the job: `2026-10-12_19-11-40_CFFFP-cube-tower-M600-test/`. If the assistant uploaded the G-code from a folder on your PC (`upload_file`), that folder is **next to the model**: `<model folder>/duet-mcp-images/<time>_<job>/`, so the pictures stay with the model. If the server does not know the local file (the job was started from DWC or the file was uploaded earlier), the job folder is created below the default folder. Pictures taken while no job runs (for example the bed check) go into the default folder (`./duet-mcp-images`). Each job folder has its own `index.html`, `latest.jpg` and limits.

The assistant tells you where the pictures of a print are and asks whether you want to keep them (keeping is the default). If you do not, it can call `discard_job_images`: you are asked to approve, and only the server's own picture files in the last job folder are deleted (never anything else, and never a folder that does not look like a job folder).

### Live viewer

The overview page is a file, and the preview pane of the desktop app shows a local file only as a still. For a page that updates itself set `DUET_VIEWER_PORT=8765` (off by default). The server then serves the page on `http://127.0.0.1:8765/` while it runs: it reloads every 5 seconds, shows the newest picture, the next pictures and a line about the machine (state, job, layer, progress, temperatures). Open it in any browser or in the preview pane. It listens on the loopback address only, answers GET for the page and for the picture files and nothing else, and refuses requests whose Host header is not the local address (so a web page on the internet cannot read your pictures). If the port is taken the server continues without the viewer. The viewer lives as long as the MCP server, that is as long as your client session.

### Periodic pictures (timeline)

Set `DUET_IMAGE_INTERVAL_SECONDS=30` (at least 5, off by default) and the server also takes a picture every 30 seconds **while a job is active** (printing, paused, resuming) plus one last picture when the job ends. These pictures are marked `_auto` in the file name and "auto" on the overview page, so the page becomes a timeline you can watch while you work, **without the assistant being asked anything and without tokens**. The assistant can look at the recent pictures when you ask (they are files in the folder). Details:

- The first two cameras are used. Each capture is one camera grab at a time (a webcam cannot be opened twice, so a snapshot you ask for waits for a running capture).
- The periodic pictures have their own limit, `DUET_IMAGE_AUTO_KEEP` (default 300), so a long print cannot push out the pictures the assistant analysed (`DUET_IMAGE_KEEP`, default 200).
- Every periodic picture is logged as `camera-image` with `"auto":true` and its SHA-256, like the others.
- It needs the supervisor (it reads the machine state from it). If three captures in a row fail, the supervisor reports `image-capture-failed`.

How to look at it:

| Where you work | What you see |
|---|---|
| Claude Code desktop app | The picture appears in the chat. The path in the answer is clickable and opens in the Browser pane, and so does `index.html`. |
| VS Code, Claude CLI in the terminal | Probably only text and the path (the documentation does not mention images from tools in the terminal; not verified). Ctrl+click on the path opens the picture in an editor tab. Open `index.html` in a browser, or with the VS Code Simple Browser / Live Preview extensions. |
| VS Code extension | Not verified whether pictures from tools appear in its chat; the saved files work the same way. |

Claude Code also keeps the original bytes of tool pictures under `~/.claude/projects/<project>/<session>/tool-results` (v2.1.283 and later); that is separate from this archive.

## Privacy

The server fetches the pictures from your cameras and passes them to your AI client. It **saves them on your disk** in the folder above (last 200, switch off with `DUET_IMAGE_DIR=off`) and never sends them anywhere else; what the AI client and provider do with a picture is up to them. Pictures can show your room and people, so do not point a camera at people or private documents, delete the folder when you no longer need it, and do not post pictures publicly without checking the background.
