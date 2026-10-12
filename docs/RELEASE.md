# Release checklist (0.1.0)

Publishing is the maintainer's decision and the maintainer's action: an assistant prepares the files and checks, but does not run `npm publish`, push tags, create releases or post in the forum.

## 1. Decide before anything else

- [x] **npm package name:** `@atomicmbag/duet-mcp` (decided 2026-10-13, already in `package.json`; the plain `duet-mcp` belongs to an unrelated project, see [PACKAGING.md](PACKAGING.md)). Check again right before publishing that nobody took it (`npm view @atomicmbag/duet-mcp` answers 404). The commands `duet-mcp` and `duet-mcp-verify-audit` keep their names.
- [x] **The npm scope.** The npm user `atomicmbag` exists (https://www.npmjs.com/~atomicmbag), so the scope `@atomicmbag` is yours. Turn on two-factor authentication for it (npm account settings) before you publish anything; `publishConfig.access` is already `public`.
- [ ] **Is alpha the right label?** The README says alpha and tested on one machine only (Duet 2 WiFi, RepRapFirmware 3.2.2). Keep it that way until other boards are reported.

## 2. Check

- [ ] `npm ci && npm run build && npm test` pass; the GitHub Actions run of the last commit is green (Ubuntu and Windows, Node 22 and 24).
- [ ] Version is the same in `package.json`, `manifest.json`, `src/index.ts` and `CHANGELOG.md` (`test/package.test.ts` checks this). Put the release date into the CHANGELOG heading.
- [ ] Hygiene, once more before the first publication (all must print nothing or only expected lines):
  ```bash
  git status --short                                   # clean
  git ls-files | grep -iE '\.(gcode|stl|log)$|^\.env$' # nothing
  git log --all --format='%an <%ae>' | sort -u         # only the noreply identity
  git grep -I -n -E '192\.168\.|password' $(git rev-list --all) -- . ':!package-lock.json' | head
  ```
  (the last command lists documentation sentences that mention the word password; there must be no real password or address of your network).
- [ ] `npm pack --dry-run` lists the expected files (about 37: `dist/`, `docs/*.md`, licence, READMEs, safety documents, `.env.example`).
- [ ] Install the tarball in an empty folder and run it:
  ```bash
  npm pack --pack-destination /tmp/t && cd /tmp/t && npm init -y && npm install ./*.tgz
  node node_modules/@atomicmbag/duet-mcp/dist/verify-audit.js nothing.log     # "File not found", exit code 2
  DUET_HOST=127.0.0.1 node node_modules/@atomicmbag/duet-mcp/dist/index.js    # starts, waits on stdin (stop it with Ctrl+C)
  ```
  (The author did this on 2026-10-12: the server answered with its name and version, 14 tools and 7 prompts.)

## 3. Publish

State of the checks on 2026-10-13 (done by the assistant, all passed): the GitHub Actions runs of the last commits are green (run 35 on `main`); no private data in files or history, only the noreply author; `@atomicmbag/duet-mcp` is free on npm; the packed tarball installs in an empty folder and starts (14 tools, 7 prompts, 4 resources); the `.mcpb` builds (3.8 MB) and passes `mcpb validate`.

The first publication, step by step (each command on its own):

```bash
npm login
```
```bash
npm publish --dry-run
```
```bash
npm publish
```

`npm login` opens a browser for your npm account (with two-factor authentication). `npm publish --dry-run` runs `prepublishOnly` (build and the tests) and lists the files without publishing; read the list once (about 43 files, no `.env`, no pictures, no G-code). `npm publish` publishes for real and cannot be undone: a version number can never be used again (you can only deprecate it, or unpublish within 72 hours if nobody depends on it). Then open `https://www.npmjs.com/package/@atomicmbag/duet-mcp` and check the README that npm shows.

- [ ] npm: the three commands above (the access is already `public`, no extra flag needed). `prepublishOnly` builds and runs the tests first. Optional later: publish from GitHub Actions with `--provenance`.
- [ ] Try it as a user would: in an empty folder `npx -y @atomicmbag/duet-mcp` must start (set `DUET_HOST`), and `claude mcp add duet -- npx -y @atomicmbag/duet-mcp` must register.
- [ ] `.mcpb` for Claude Desktop: build as described in [PACKAGING.md](PACKAGING.md) (`npm ci --omit=dev` in a clean copy, `mcpb validate`, `mcpb pack`), install it in Claude Desktop once, check that the settings dialog asks for host, password and read-only.
- [ ] GitHub release: `git tag -a v0.1.0 -m "0.1.0 (alpha)"`, `git push origin v0.1.0`, create the release from the tag with the CHANGELOG text, attach the `.mcpb`, tick "pre-release".

## 4. After

- [ ] Answer in the forum thread (link to the release and the hardware report template) and post the entry for the Community Projects Wiki ([forum-community-wiki-draft.md](forum-community-wiki-draft.md)).
- [ ] Turn on watching for issues; hardware reports are the most valuable input.
- [ ] Next versions follow SemVer; while the major version is 0, tools and settings may still change, and every change goes into the CHANGELOG.
