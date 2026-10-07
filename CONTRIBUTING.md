# Contributing to duet-mcp

Everyone who contributes constructively is welcome: code, tests, hardware reports, documentation, translations, ideas, criticism of the safety design. You do not need to own a Duet to help.

*Deutsch: Beiträge sind willkommen, auch auf Deutsch (Issues, Diskussion). Code, Commit-Texte und Dokumentation der Regeln bitte auf Englisch, damit die Duet3D-Community mitlesen kann.*

## The most useful contribution: a hardware report

The server is verified on one machine only (Duet 2 WiFi, RepRapFirmware 3.2.2, Cartesian). Every other board, firmware and kinematics is "expected to work, untested". Open an issue with the template **Hardware test report** and tell us what worked and what did not. Please start with read-only mode (the default) and only test moving or heating on a machine you can supervise, with the emergency stop within reach.

## Ground rules (this software can heat and move a machine)

1. **Safety changes need tests.** Anything in `src/guard.ts`, `src/supervisor.ts`, `src/homing.ts`, `src/confirm.ts`, `src/watchdog.ts`, `src/speedprofile.ts` or `src/jobcontrol.ts` must come with tests that show the new behaviour and that the old protections still hold.
2. **Never weaken a safety rule silently.** If a rule is wrong or too strict, say so in the pull request and explain why. Rules are listed in `SAFETY_RULES.md`; keep it in sync with the code.
3. **The model cannot approve for the human.** Do not add a way for the AI side to confirm its own actions.
4. **Read-only stays the default.** Control tools exist only with `DUET_READ_ONLY=false`.
5. **No secrets, no personal data.** Never commit `.env`, passwords, IP addresses of your network, camera pictures with people, or logs that contain them. Use the commit identity of your choice, but check that it does not expose a private address.
6. **Be honest in the docs.** The README says what is tested and what is not. Do not mark something as verified unless it ran on real hardware or a test proves it.

## Development

```bash
npm install
npm run build      # tsc
npm test           # vitest, uses a simulated Duet, no hardware needed
```

Tests run against `test/helpers/mockDuet.ts`, a simulated Duet. If you add a firmware behaviour, extend the mock and note which real firmware version showed it. Set `DUET_CONFIRM_DIALOG=never` when you run tests so no system dialog pops up (CI does this).

Style: TypeScript, small pure modules for rules (no I/O) plus thin wiring in `src/index.ts`; match the surrounding code. Keep tool descriptions short and precise, because the model reads them (`test/guidance.test.ts` checks them).

## Pull requests

- One topic per pull request, with a short description of what and why.
- `npm run build` and `npm test` must pass (CI runs Ubuntu and Windows, Node 22 and 24).
- Say how you checked it: simulated only, or on which board and firmware.
- Be kind in review. Disagreement about safety is welcome, and it is settled with arguments and tests.

## Reporting a vulnerability

Please do not open a public issue for security problems. See `SECURITY.md`.

## License of contributions

By submitting a contribution you agree that it is released under the project license (MIT, see `LICENSE`).
