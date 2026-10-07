# Packaging

## npm (`npx duet-mcp`)

`npm pack --dry-run` shows what ships (compiled `dist/`, licence, README, safety documents, `.env.example`). Publishing is done by the maintainer: `npm publish` runs `prepublishOnly` (build and tests first). Use `npm publish --provenance` from CI later. Then:

```bash
claude mcp add duet -e DUET_HOST=192.168.x.x -e DUET_PASSWORD=... -- npx -y duet-mcp
```

(Prefer a `.env` file next to where you start the server over putting the password on a command line.)

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
