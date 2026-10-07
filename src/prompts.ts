/**
 * Guidance for the model: the server instructions (sent when a client connects) and prompt templates for the common workflows.
 * Kept free of I/O so it can be tested on its own.
 */

export const INSTRUCTIONS = [
  "duet-mcp operates a 3D printer or CNC machine with a Duet board (RepRapFirmware) over the local network. Heaters and motors are dangerous: be careful, and never claim something is safe, only report what the checks found.",
  "",
  "Start every session with get_machine_info (board, firmware, how far it is verified) and job_status (state, heaters, supervisor events).",
  "Before a print: preflight_gcode on the local file (read-only; optional patched copy), then upload_file, home_axes if axes are not homed, then start_job.",
  "The server asks the human itself for approval (start_job, home_axes, heating, risky G-code). You cannot approve for them and the confirm argument is ignored. If a request is declined or cannot be asked, report it and stop; do not try to work around it.",
  "Keep answers short. While a job runs, poll job_status every few minutes (not in a tight loop) and use get_camera_snapshot at layer changes. The server supervises temperatures and progress on its own; if job_status shows events such as heatup-timeout, temperature-deviation, over-temperature, no-progress, duet-restarted or connection-lost, tell the user at once and do not resume without their consent.",
  "emergency_stop is always available. pause_job and cancel_job never need approval. A cancelled job leaves the heaters on: switch them off with send_gcode (M104 T0 S0, M140 S0) when the user wants that.",
  "Without DUET_READ_ONLY=false only the read tools exist. Config, firmware and limit changes are never possible through this server; the user does them in config.g.",
].join("\n");

export interface PromptDef {
  name: string;
  title: string;
  description: string;
  args: Record<string, { description: string; optional?: boolean }>;
  build: (a: Record<string, string | undefined>) => string;
}

const withArg = (v: string | undefined, fallback: string) => (v && v.trim() ? v.trim() : fallback);

export const PROMPTS: PromptDef[] = [
  {
    name: "pre_print_check",
    title: "Pre-print check",
    description: "Check a local G-code file against the machine and report GO or NO-GO. Starts nothing.",
    args: {
      file: { description: "Local path of the .gcode file" },
      nozzle: { description: "Nozzle diameter in mm, e.g. 0.4", optional: true },
    },
    build: (a) => [
      `Run a pre-print check for the G-code file "${withArg(a.file, "<file>")}" on the connected machine. Do NOT start anything.`,
      "1. get_machine_info: board, firmware, verification status.",
      "2. job_status: the machine must be idle; note heaters and any supervisor events.",
      `3. preflight_gcode with that file${a.nozzle ? ` and nozzle=${a.nozzle}` : " (ask for the nozzle diameter if you do not know it)"}. If it warns about tool selection or G28 in the start block, offer the fixes select-tool and strip-g28 (it writes a patched copy, the original stays untouched).`,
      "4. get_machine_profile if limits matter for the print area. get_sensors if a filament monitor or probe is expected.",
      "5. If a camera is configured: get_camera_snapshot and say whether the bed looks empty and clean. If the picture is too dark, say so instead of guessing.",
      "6. Summarise as GO or NO-GO with the reasons in a short list. Only report what the checks found; do not promise the print will succeed.",
    ].join("\n"),
  },
  {
    name: "start_print_supervised",
    title: "Start and supervise a print",
    description: "Start a file that is on the SD card and follow the print with status, camera and the supervisor events.",
    args: {
      file: { description: "File name on the SD card (0:/gcodes), e.g. cube.gcode" },
      profile: { description: 'Speed profile per layer, e.g. "1:30,2:50,3:80,6:100" (optional)', optional: true },
    },
    build: (a) => [
      `Start "${withArg(a.file, "<file>")}" on the connected machine and supervise it.`,
      "1. job_status: the machine must be idle. If axes are not homed, run home_axes (the user is asked to approve).",
      a.profile ? `2. set_speed_profile with "${a.profile}".` : "2. Optionally set_speed_profile (the first_layer_profile prompt explains a good start).",
      "3. get_camera_snapshot if a camera exists: the bed must be clear. Ask the user if you are unsure.",
      "4. start_job (the user is asked to approve). If it is declined, stop.",
      "5. Supervise: call job_status every few minutes and get_camera_snapshot at layer changes up to layer 7, then now and then. Give short updates (layer, progress, temperatures, speed).",
      "6. If job_status shows heatup-timeout, temperature-deviation, over-temperature, no-progress, duet-restarted or connection-lost, tell the user immediately. Do not resume a paused job without their consent.",
      "7. When the job ends, check that the heaters are off (job_status) and the speed factor is back at 100 %. Offer to switch the heaters off if they are not.",
    ].join("\n"),
  },
  {
    name: "first_layer_profile",
    title: "Slow first layers",
    description: "Set a speed profile that prints the first layers slowly for better adhesion.",
    args: { material: { description: "PLA, PETG, ABS ... (optional)", optional: true } },
    build: (a) => [
      `Set a slow first-layer speed profile${a.material ? ` for ${a.material}` : ""}.`,
      'Use set_speed_profile with "1:30,2:50,3:80,6:100": 30 % for the first layer, 50 % for the second, 80 % for layers 3 to 5, then 100 %. This is the profile the author used for PLA and sometimes ABS; it is a starting point.',
      "Then job_status to confirm the profile. The server sends the first step before the job starts and resets the speed to 100 % when the job ends.",
      "Tell the user to watch adhesion in the first layers (camera or in person) and to adjust the profile if the first layer is too slow or lifts.",
    ].join("\n"),
  },
  {
    name: "bed_leveling_assistant",
    title: "Manual bed leveling (guided)",
    description: "Guide the user through manual bed leveling. You move the head, the user turns the screws.",
    args: { points: { description: "Number of points: 4 (corners) or 5 (corners and centre)", optional: true } },
    build: (a) => [
      `Guide the user through manual bed leveling with ${withArg(a.points, "4")} points. You move the head, the user adjusts the screws.`,
      "Rules: the nozzle is moved near the bed, so be careful and ask before every move that could touch it. Never go below Z 0, and only trust Z 0 as the bed surface if the user confirms their Z endstop is set up that way.",
      "1. Ask the user to clear the bed and say whether the bed should be heated for the leveling (their usual temperature). Then job_status (idle) and get_machine_profile (X/Y/Z limits).",
      "2. home_axes (the user is asked to approve).",
      "3. For each point: send_gcode to lift Z to 5 mm, move X/Y to the point (stay inside the limits and about 10-15 mm inside the bed edge), lower Z in small steps while the user checks the gap with a sheet of paper; tell the user which way to turn the screw. Wait for the user after every step.",
      "4. Repeat the round until all points feel the same, then lift Z and report. Offer to switch the heaters off.",
    ].join("\n"),
  },
  {
    name: "troubleshoot_connection",
    title: "Troubleshoot the connection",
    description: "Find out why the Duet cannot be reached or rejects the server.",
    args: {},
    build: () => [
      "Diagnose the connection to the Duet. Call get_machine_info and job_status and read the error text carefully.",
      '- "rejected the password": the DUET_PASSWORD in .env is wrong, or the board restarted and loaded the password from config.g. Do not guess passwords; ask the user to check.',
      '- "no free session": too many open sessions. Ask the user to close DWC tabs and phone apps.',
      '- "not reachable": the machine is off, off the WiFi, or its IP changed. Ask the user to check power, WiFi and the address.',
      '- "duet-restarted": the board restarted; heaters are off and axes are not homed; a running job is gone.',
      "- Something else: report the exact text. Do not retry in a loop.",
    ].join("\n"),
  },
];
