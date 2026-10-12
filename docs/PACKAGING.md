# Packaging

## npm

**The name `duet-mcp` is taken** on npm by an unrelated project (a shared JSON document editor, version 0.8.0, created in September 2026), so this package must be published under another name. Checked on 2026-10-12 and free at that time: `@atomicmbag/duet-mcp` (scoped; needs an npm user or organisation named `atomicmbag`), `reprap-duet-mcp`, `rrf-mcp`, `duet-rrf-mcp`, `mcp-duet`, `duet-printer-mcp`, `duet3d-mcp` (avoid: it uses the company brand, and this is an unofficial project). Re-check with `npm view <name>` right before publishing; a 404 means free.

Until the name is chosen, nothing in the documentation tells users to run `npx duet-mcp` (they would run the other project).

`npm pack --dry-run` shows what ships (compiled `dist/`, licence, README, safety documents, `docs/*.md`, `.env.example`). Publishing is done by the maintainer, see [RELEASE.md](RELEASE.md). After publishing, the commands are:

```bash
claude mcp add duet -- npx -y <package name>
npx -p <package name> duet-mcp-verify-audit duet-mcp-audit.log
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
