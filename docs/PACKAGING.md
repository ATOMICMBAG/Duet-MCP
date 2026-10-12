# Packaging

## npm

**Package name: `@atomicmbag/duet-mcp`** (decided 2026-10-13). The plain name `duet-mcp` is taken on npm by an unrelated project (a shared JSON document editor, version 0.8.0, created in September 2026), and it is a good reason for a scoped name anyway: it shows who publishes the package and avoids mix-ups. Checked on 2026-10-12: `@atomicmbag/duet-mcp` was free. Other names that were free then, in case the scope cannot be used: `reprap-duet-mcp`, `rrf-mcp`, `duet-rrf-mcp`, `mcp-duet`, `duet-printer-mcp` (not `duet3d-mcp`: that is the company brand, and this is an unofficial project).

A scoped package belongs to an npm user or organisation of the same name, so the npm user (or an organisation) called `atomicmbag` must exist and be the publisher; `package.json` has `publishConfig.access = public` so that `npm publish` makes it public.

`package.json` already carries the new name. Nothing is published yet, so the npm page of that name does not exist until the first release. Until then the documentation says to install from source and does not tell anyone to run `npx duet-mcp` (they would run the other project).

`npm pack --dry-run` shows what ships (compiled `dist/`, licence, README, safety documents, `docs/*.md`, `.env.example`). Publishing is done by the maintainer, see [RELEASE.md](RELEASE.md). After publishing, the commands are:

```bash
claude mcp add duet -- npx -y @atomicmbag/duet-mcp
npx -p @atomicmbag/duet-mcp duet-mcp-verify-audit duet-mcp-audit.log
```

(Prefer a `.env` file next to where the server lives over putting the password on a command line. The commands `duet-mcp` and `duet-mcp-verify-audit` stay the same whatever the package is called.)

## Claude Desktop (`.mcpb`)

`manifest.json` describes the bundle (settings: host, password stored by Claude Desktop, read-only switch, default `true`). Build it from a clean copy so only production dependencies are inside:

```bash
npm run build
# in a temporary folder: dist/, manifest.json, package.json, package-lock.json, LICENSE, README.md, SAFETY.md
npm ci --omit=dev
npx @anthropic-ai/mcpb validate manifest.json
npx @anthropic-ai/mcpb pack . duet-mcp.mcpb
```

The bundle is about 3.7 MB. `*.mcpb` files are git-ignored; attach the file to a GitHub release instead.

## Versions

SemVer. While the major version is 0, tools and settings may change; every change goes into `CHANGELOG.md`. The version must match in `package.json`, `manifest.json`, `CHANGELOG.md` and the server (`src/index.ts`); `test/package.test.ts` checks that.
