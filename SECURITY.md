# Security policy

duet-mcp can heat and move real machines, so security and safety reports are taken seriously.

## What to report privately

- A way to make the server perform an action the guard, the supervisor or the human confirmation should have stopped (for example a G-code that bypasses the block list, or an approval that is accepted without the human).
- A way to leak the Duet password or other secrets (logs, resources, error messages).
- Anything that lets a remote party, not the configured user, send commands.

## How

Use GitHub's private vulnerability reporting ("Security" tab, "Report a vulnerability") on this repository. Do not post details in a public issue. If that is not available, open a public issue that only says you have a security report and ask for a private channel, without details.

You will get an answer as soon as the maintainer can; this is a small volunteer project, so please be patient. Fixes come with a test that reproduces the problem.

## Scope and limits

The server is meant for a trusted home or workshop network. It does not add network security to the Duet itself: the Duet's own HTTP interface is unencrypted, and the password travels in clear text inside your LAN. Do not expose the Duet to the internet. See `SAFETY.md` for the full disclaimer.
