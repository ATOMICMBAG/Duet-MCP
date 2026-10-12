# Release checklist (0.1.0)

Publishing is the maintainer's decision and the maintainer's action: an assistant prepares the files and checks, but does not run `npm publish`, push tags, create releases or post in the forum.

## 1. Decide before anything else

- [x] **npm package name:** `@atomicmbag/duet-mcp` (decided 2026-10-13, already in `package.json`; the plain `duet-mcp` belongs to an unrelated project, see [PACKAGING.md](PACKAGING.md)). Check again right before publishing that nobody took it (`npm view @atomicmbag/duet-mcp` answers 404). The commands `duet-mcp` and `duet-mcp-verify-audit` keep their names.
- [ ] **The npm scope.** The scope `@atomicmbag` needs an npm user or organisation of that name that you control (create it or check it at npmjs.com). `publishConfig.access` is already `public`.
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

- [ ] npm: `npm login` (with two-factor authentication), then `npm publish` (add `--access public` for a scoped name). `prepublishOnly` builds and runs the tests first. Optional later: publish from GitHub Actions with `--provenance`.
- [ ] Try it as a user would: in an empty folder `npx -y @atomicmbag/duet-mcp` must start (set `DUET_HOST`), and `claude mcp add duet -- npx -y @atomicmbag/duet-mcp` must register.
- [ ] `.mcpb` for Claude Desktop: build as described in [PACKAGING.md](PACKAGING.md) (`npm ci --omit=dev` in a clean copy, `mcpb validate`, `mcpb pack`), install it in Claude Desktop once, check that the settings dialog asks for host, password and read-only.
- [ ] GitHub release: `git tag -a v0.1.0 -m "0.1.0 (alpha)"`, `git push origin v0.1.0`, create the release from the tag with the CHANGELOG text, attach the `.mcpb`, tick "pre-release".

## 4. After

- [ ] Answer in the forum thread (link to the release and the hardware report template) and post the entry for the Community Projects Wiki ([forum-community-wiki-draft.md](forum-community-wiki-draft.md)).
- [ ] Turn on watching for issues; hardware reports are the most valuable input.
- [ ] Next versions follow SemVer; while the major version is 0, tools and settings may still change, and every change goes into the CHANGELOG.
