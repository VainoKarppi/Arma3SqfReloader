# SqfReloader — VS Code Extension Plan

Status: the correctness, security-declaration and packaging blockers are closed. What is left before
the first publish is the publisher/listing work ([§4](#sec-4), [§6](#sec-6)) plus the hardening items in
[§5](#sec-5). Open questions are in [§13](#sec-13).

Scope: what must be **fixed or added before publishing to the Visual Studio Marketplace**, followed by a
**future backlog** of features that are explicitly *not* required for the first public release. Jump table:
[Contents](#contents).

Current version: `3.8.1` (`package.json`, `SqfReloaderExtension/SqfReloaderExtension.csproj`, `src/BuildStamp.cs`).
The extension is in **beta**; the first public Marketplace release will restart at `1.0.0`.

Related documents: [CHANGELOG.md](./CHANGELOG.md) (release notes of what is already done, plus the
entry template), [LIMITATIONS.md](./LIMITATIONS.md) (support matrix: working / should work / to be
fixed / won't fix) and [AGENTS.md](./AGENTS.md) (agent workflow and verification commands).

---

<a id="contents"></a>

## Contents

Everything this plan tracks, grouped by kind. Each entry links straight to its item, and every item
carries **Why**, **Do** and **Done when** lines so it can be verified rather than judged.

**48 tracked items** — 1 release blocker · 7 hardening · 5 packaging · 5 documentation ·
5 engineering · 6 polish · 3 deferred · 16 future features.

**Done in this build (10):** `HARD-01`, `HARD-02`, `HARD-03`, `HARD-05`, `HARD-07`, `POL-02`,
`DOC-02`, `DOC-03`, `ENG-04`, `PKG-01` (last pin). How to verify them, in VS Code and in Arma:
[TESTING.md](./TESTING.md).

**Sections:**
[1 Reading guide](#sec-1) ·
[2 Verified current state](#sec-2) ·
[3 Definition of "ready to publish"](#sec-3) ·
[4 Release blockers](#sec-4) ·
[5 Hardening](#sec-5) ·
[6 Packaging](#sec-6) ·
[7 Documentation](#sec-7) ·
[8 Engineering](#sec-8) ·
[9 Polish](#sec-9) ·
[10 Deferred](#sec-10) ·
[11 Future backlog](#sec-11) ·
[12 Execution order](#sec-12) ·
[13 Decisions and open questions](#sec-13) ·
[14 Design appendix `FUT-16`](#sec-14)

### Release blockers (`REL`) — do not publish while open

| Item | What it covers |
| --- | --- |
| [REL-01](#rel-01) `OPEN` | Publishing prerequisites: verified `VainoKarppi` publisher, `VSCE_PAT`, 20–40 s GIF + 3–4 screenshots, support/QnA link, "no telemetry" privacy statement |

### Hardening and correctness before launch (`HARD`)

| Item | What it covers |
| --- | --- |
| [HARD-01](#hard-01) &#10003; | Status polling is expensive and never idles — make the timer idle-aware |
| [HARD-02](#hard-02) &#10003; | Project settings are re-read from disk on nearly every call — cache them |
| [HARD-03](#hard-03) &#10003; | `taskkill /IM arma3_x64.exe /F` kills Arma instances the extension did not start |
| [HARD-04](#hard-04) | Multi-root workspaces behave unpredictably (folder 0 wins for settings and roles) |
| [HARD-05](#hard-05) &#10003; | HEMTT cannot be spawned when it resolves to a `.cmd`/`.bat` shim |
| [HARD-06](#hard-06) | Diagnostics and error surfaces are inconsistent |
| [HARD-07](#hard-07) &#10003; | Dead code and duplicated API helpers |

### Marketplace listing and packaging (`PKG`)

| Item | What it covers |
| --- | --- |
| [PKG-01](#pkg-01) &#10003; | `package.json` metadata for the gallery (`@types/vscode` pin, categories, keywords) |
| [PKG-02](#pkg-02) | Marketplace readme quality — feature tour, GIF, quick start |
| [PKG-03](#pkg-03) | Packaging allow/deny list — `vsce ls` must ship only runtime files |
| [PKG-04](#pkg-04) | Repository hygiene — no `out/` orphans, no build artifacts committed |
| [PKG-05](#pkg-05) | Publisher and listing assets — icon, banner, support links |

### Documentation and settings contract (`DOC`)

| Item | What it covers |
| --- | --- |
| [DOC-01](#doc-01) | Settings table drift between `package.json` and the readmes |
| [DOC-02](#doc-02) &#10003; | Incorrect setting-scope statement (global vs project file) |
| [DOC-03](#doc-03) &#10003; | Command name mismatches in the documentation |
| [DOC-04](#doc-04) | Document the API and its security behavior precisely |
| [DOC-05](#doc-05) | Troubleshooting parity across the readmes |

### Engineering infrastructure (`ENG`)

| Item | What it covers |
| --- | --- |
| [ENG-01](#eng-01) | Automated tests for the pure logic (`arma`, `pbo`, `links`, `launchArgs`) |
| [ENG-02](#eng-02) | CI pipeline (build + `verify-*.js` on every push) |
| [ENG-03](#eng-03) | Lint/format baseline |
| [ENG-04](#eng-04) &#10003; | Version consistency check (`package.json` / `.csproj` / `BuildStamp.cs`) |
| [ENG-05](#eng-05) | Smoke test on a clean machine |

### Optional polish before launch (`POL`)

| Item | What it covers |
| --- | --- |
| [POL-01](#pol-01) | "SqfReloader: Doctor" command — one report of everything misconfigured |
| [POL-02](#pol-02) &#10003; | First-run walkthrough |
| [POL-03](#pol-03) | Settings discoverability |
| [POL-04](#pol-04) | Status bar interaction (click targets, tooltip detail) |
| [POL-05](#pol-05) | SQF header snippets (`params` block, `CfgFunctions` class, `fn_` skeleton) |
| [POL-06](#pol-06) | Code lens "Reload this function" |

### Deferred — accepted for the first release (`DEF`)

| Item | What it covers |
| --- | --- |
| [DEF-01](#def-01) | Local REST API hardening (token, 1 MB body cap, CORS, `Host` check) |
| [DEF-02](#def-02) | Multi-root workspaces (see also [HARD-04](#hard-04)) |
| [DEF-03](#def-03) | "Stop Arma 3" stops every Arma instance (see also [HARD-03](#hard-03)) |

### Future backlog — features, *not* part of this release (`FUT`)

| Item | What it covers |
| --- | --- |
| [FUT-01](#fut-01) | SQF language support: TextMate grammar, completion, signature help, semantic tokens, formatter |
| [FUT-02](#fut-02) | A real SQF debugger (DAP): breakpoints, stepping, call stack, variables |
| [FUT-03](#fut-03) | Test Explorer integration for Arma unit tests |
| [FUT-04](#fut-04) | Multi-machine / remote workflows (Remote-SSH/WSL, authenticated server attach) |
| [FUT-05](#fut-05) | Multi-root workspaces, first class |
| [FUT-06](#fut-06) | Reload scope beyond functions (`config.cpp`, `description.ext`, `preInit`/`postInit` replay) |
| [FUT-07](#fut-07) | Change-aware reload (everything changed since the last reload or a git baseline) |
| [FUT-08](#fut-08) | Release/packaging workflow inside VS Code (HEMTT build/launch, signing, Workshop upload) |
| [FUT-09](#fut-09) | MCP server / broader AI integration |
| [FUT-10](#fut-10) | RPT and log tooling: clickable `File <path>, line N`, error timeline, support bundle |
| [FUT-11](#fut-11) | Live performance insight: reload timings, compile warnings as diagnostics + quick fixes |
| [FUT-12](#fut-12) | Opt-in telemetry and crash reporting |
| [FUT-13](#fut-13) | Localisation via `vscode.l10n` |
| [FUT-14](#fut-14) | Mission and mod scaffolding gallery |
| [FUT-15](#fut-15) | Broader Arma family support (Reforger/Enfusion) |
| [FUT-16](#fut-16) | **Function knowledge base** — Wiki hover docs for `BIS_fnc_*` / `TAG_fnc_*`, `CfgFunctions` index, single-file PBO source navigation on Ctrl+click, community function headers, new-function detection. Full design in [§14](#sec-14) |

### Design appendix (`FUT-16`) — [§14](#sec-14)

| Part | What it covers |
| --- | --- |
| [14.1](#app-14-1) | Goals and non-goals |
| [14.2](#app-14-2) | Measured facts: PBO header timings, entry layout, Wiki API and rate limits |
| [14.3](#app-14-3) | Architecture diagram (four producers → one lookup service) |
| [14.4](#app-14-4) | Module layout: new files, exports, edited files |
| [14.5](#app-14-5) | Storage layout under `globalStorageUri` + `FunctionDoc` / `PboEntry` schemas |
| [14.6](#app-14-6) | Pipelines A–E: PBO index, `CfgFunctions` enumeration, wiki snapshot, community headers, refresh/diff |
| [14.7](#app-14-7) | Hover and navigation UX, with the rendered hover example |
| [14.8](#app-14-8) | Settings and commands |
| [14.9](#app-14-9) | Phases P1–P5 with "Done when" gates |
| [14.10](#app-14-10) | Risks and mitigations |
| [14.11](#app-14-11) | Verification scripts |
| [14.12](#app-14-12) | Documentation duties when this lands |

---

<a id="sec-1"></a>

## 1. How to read this document

| Prefix | Meaning |
| --- | --- |
| `REL-xx` | Release blocker. Do not publish while any of these is open. |
| `HARD-xx` | Hardening/quality work that should ship with the first public release. |
| `PKG-xx` | Marketplace listing, packaging and repository hygiene. |
| `DOC-xx` | Documentation and settings-contract accuracy. |
| `ENG-xx` | Engineering infrastructure (tests, CI, release automation). |
| `POL-xx` | Optional polish, nice to have before release. |
| `FUT-xx` | Future features. **Not** part of this release. |
| `DEF-xx` | Deferred: known, deliberately not required before the first release. |

Only **open** items are listed. Finished work is recorded in [CHANGELOG.md](./CHANGELOG.md) rather
than kept here. Every item has a "Done when" line so the release can be verified rather than judged
by feel.

---

<a id="sec-2"></a>

## 2. Verified current state

Facts gathered from the repository at the time of writing (use these when estimating):

- Extension: 36 TypeScript modules (`src/*.ts`), strict `tsc`, `target ES2022`, `engines.vscode ^1.99.0`,
  `@types/vscode` pinned to `~1.99.0` so `tsc` rejects APIs newer than the declared engine.
  Large modules were split by responsibility: `projectViewHtml.ts` (webview markup), `launchArgs.ts`
  (command line), `duplicateFunctions.ts` (duplicate-function diagnostics), `armaDetect.ts`
  (install discovery), `workspaceHelpers.ts` (workspace queries), `missionRecompile.ts`
  (`allowFunctionsRecompile`), `tutorial.ts` (guided tour state and steps).
- Documentation: `README.md` is the short GitHub landing page; `README-FULL.md` holds the complete
  guide; `README-MARKETPLACE.md` is packaged (`--readme-path`); `LIMITATIONS.md`, `CHANGELOG.md`,
  `PLAN.md` and `AGENTS.md` (agent instructions) sit next to them.
- Examples: "Create example mod" writes `ClientMod/` (`@ExampleMod` + `missions` + `mpmissions` +
  `.hemtt` project) and `ServerMod/` (`@ExampleServerMod` + `ExampleMission.Altis` + `server.cfg` +
  `.hemtt` project). Both mods carry `$PBOPREFIX$` so `hemtt check` runs out of the box; `pbo.ts`
  skips that file when staging the launch PBO.
- Native side: C# NativeAOT HTTP API (`SqfReloaderExtension/src/Plugin/*`), Win-x64 only, shipped as
  `vscode-runtime/mod/@SqfReloader`.
- Feature surface: hot reload of `fn_*.sqf`, mission function restart, run-SQF-with-parameters, Eden/host/dedicated
  launch, PBO staging, junction/mission linking, project settings view, debug console with watches, lifecycle hooks,
  HEMTT checks (incl. unsaved buffers), SQF definition/hover/reference providers, and an `armaAiTool` language-model tool.
- Build: `build-all.ps1` → DLL + `@SqfReloader` PBO + runtime bundle + `tsc` + `vsce package`.
- Verification: hand-run scripts in `scripts/verify-*.js` (some need a live Arma + mod folder), plus the PowerShell
  launcher in `SqfReloaderExtension/tools/test-extension.ps1` driving the `SqfReloaderExtension/tests/callExtension`
  harness. `npm run verify` runs the version gate plus the template/tags checks; `node scripts/verify-tutorial.js`
  covers the guided tour and the settings cache; [TESTING.md](./TESTING.md) is the manual checklist.
- Missing today: any CI workflow, any unit test runner, any linter/formatter config, screenshots/GIF in the
  Marketplace readme. (`CHANGELOG.md` and `LIMITATIONS.md` were added; Marketplace metadata is now present.)
- Repository hygiene: `out/` was shipping `preLaunch.js` and `reloader.js` from deleted sources; fixed by a clean
  build step (`out/` holds exactly one `.js` per source module).
- Measured for `FUT-16` (2026-11-12, Arma 3 `2.22.0.154089`, one install): 196 `Addons\*.pbo` / 15.5 GB, whose
  headers scan in **54 ms** (58 817 entries, 2 804 `*.sqf`, no `Cprs` compression); the Wiki exposes 2 062 pages in
  `Category:Arma 3: Functions` through a MediaWiki API behind an intermittent Cloudflare challenge. Full numbers and
  consequences in §14.2.

---

<a id="sec-3"></a>

## 3. Definition of "ready to publish"

The release is ready when all of the following are true:

1. All `REL-*` items are closed and verified on a clean Windows 10/11 machine with only VS Code, Arma 3 and Arma 3 Tools.
2. `npx @vscode/vsce ls` output contains only intended runtime files (no stale `out/*.js`, no dev scripts).
3. A fresh install from the produced `.vsix` completes the first-run flow (Discover → Create example → Play → edit and
   save → see the change in Arma) without opening the output channel.
4. `CHANGELOG.md` and the Marketplace readme describe the shipped feature set, with at least one screenshot/GIF.
5. `LIMITATIONS.md` is current: every row in its support matrix still matches the shipped behavior.
5. A reviewer can reproduce the build with documented commands only.

---

<a id="sec-4"></a>

## 4. Release blockers (`REL`)

<a id="rel-01"></a>

### REL-01 — Publishing prerequisites (publisher account, listing media) → `OPEN`

- **Why:** `vsce publish` fails without a verified `VainoKarppi` publisher and a `VSCE_PAT` that
  belongs to it, and the listing is much weaker without screenshots/GIF.
- **Do:**
  - Confirm the publisher exists and that the `VSCE_PAT` used for publishing belongs to it.
  - Add one 20-40 s GIF (edit -> save -> change visible in Arma) and 3-4 screenshots to
    `media/`, referenced from `README-MARKETPLACE.md` (see also `PKG-02`).
  - Add a support/QnA link and a short privacy statement ("no telemetry; the local API binds to
    127.0.0.1"); see `PKG-05`.
- **Done when:** `vsce publish --dry-run` succeeds with the new metadata and the packaged
  readme/changelog render locally.

---

<a id="sec-5"></a>

## 5. Hardening and correctness before launch (`HARD`)

<a id="hard-01"></a>

### HARD-01 — Status polling is expensive and never idles → `DONE`

- **Done:** the status loop is a self-scheduling timer with a 2 s interval while Arma/its API is up
  and 15 s when everything is down; the separate 3 s connection timer was removed (the connection
  monitor triggers a refresh on state change instead), and `GameConnectionMonitor` backs off to
  15 s while nothing runs, with `wake()` after a launch. Commands still refresh immediately.

- **Why:** `refreshStatus` runs every 2 s and spawns `tasklist` (twice: game + server), issues a `GET /api/status`, while
  `GameConnectionMonitor` polls the same endpoint at 1–3 s. That is continuous process spawning and connection attempts
  for the entire VS Code session, even with Arma closed — measurable CPU/battery cost and a noisy source of error logs.
- **Where:** `src/extension.ts` (`statusTimer`, `connectionTimer`), `src/connectionMonitor.ts`, `src/launcher.ts`
  (`queryProcessImage`).
- **Do:** Poll fast only while a launch is in flight or a connection is being established; back off to 10–15 s when
  everything is down; coalesce `tasklist` calls; drive "game exited" from the tracked child process when we launched it.
- **Done when:** With Arma closed and VS Code idle, no `tasklist` spawns occur for 60 s of observed steady state.

<a id="hard-02"></a>

### HARD-02 — Project settings are re-read from disk on nearly every call → `DONE`

- **Done:** `readProjectSettings()` keeps a parse cache keyed by path + mtime + size with a 250 ms
  stat window, invalidated by `writeProjectSettings()` and by the settings watcher; `configuredLogLevel()`
  reads the cache directly. Covered by `scripts/verify-tutorial.js` ("Project settings cache").

- **Why:** `readSettings()` parses `.vscode/sqfReloader-settings.json` synchronously, and `log()`/`logInfo()` call
  `configuredLogLevel()` → `readSettings()` per line. On top of the 2 s status loop this is a lot of synchronous I/O on
  the extension host.
- **Where:** `src/settings.ts`, `src/projectSettings.ts`, `src/extension.ts` (watcher already exists).
- **Do:** Cache parsed settings keyed by workspace folder + mtime, invalidate in the existing settings watcher and in
  `onDidChangeWorkspaceFolders`, and use the cached value in the logging helpers.
- **Done when:** Profiling an idle session shows zero settings-file reads, and editing the file still applies immediately.

<a id="hard-03"></a>

### HARD-03 — "Stop Arma 3" kills every Arma instance → `DONE`

- **Done:** `launcher.stopArma()` targets the remembered PID (`taskkill /PID … /T /F`) and only
  falls back to the image-name kill when the command passes `allowExternal`, which it does after a
  dialog that states Arma was not started by VS Code. The dedicated server stop reuses the same
  PID targeting.

- **Why:** `sqfReloader.stop` runs `taskkill /IM arma3_x64.exe /F`, which closes Arma sessions the user started outside
  the workspace (another mod, another profile). Unsaved in-game editor state can be lost.
- **Where:** `src/extension.ts` (`sqfReloader.stop`), `src/launcher.ts`.
- **Do:** Remember the PID spawned by `launchArma` and target it (`taskkill /PID … /T`). When Arma was not launched by us,
  warn explicitly ("This will close an Arma 3 instance started outside VS Code") before falling back to the image-name kill.
- **Done when:** With two Arma instances running, stopping from VS Code closes only the one it started.

<a id="hard-04"></a>

### HARD-04 — Multi-root workspaces behave unpredictably

- **Why:** `currentWorkspace()` returns `workspaceFolders[0]`, so project settings, the project view, mod roles and save
  handling all key off the first folder. The settings watcher fires for *any* folder but re-reads only the first.
- **Where:** `src/projectSettings.ts` (`currentWorkspace`), `src/projectView.ts` (`root`), `src/extension.ts`.
- **Do:** Resolve settings from the folder that contains the document/URI being acted on (a helper already exists in
  `hasConfiguredProjectUri`), and make the project view follow the active editor's folder. If full support is out of
  scope, document "single-folder workspaces only" and refuse mod-role changes for other roots with a clear message.
- **Done when:** Two Arma projects open side by side each keep their own settings and reload behavior, or the limitation is
  documented and enforced with an explicit message.

<a id="hard-05"></a>

### HARD-05 — HEMTT cannot be spawned when it resolves to a `.cmd`/`.bat` shim → `DONE`

- **Done:** `hemtt.runProcess` looks the command up through `PATH`/`PATHEXT`, prefers a real `.exe`
  and runs a `.cmd`/`.bat` shim through `cmd.exe /d /s /c` with quoting.

- **Why:** `spawn("hemtt", …)` without `shell: true` throws `EINVAL` on current Node for `.cmd`/`.bat` wrappers
  (scoop/Chocolatey shims). Users with HEMTT installed that way see "hemtt command not found".
- **Where:** `src/hemtt.ts` (`runProcess`, executable resolution).
- **Do:** Resolve the real executable (`.exe` first) and, when only a shim exists, spawn via `cmd.exe /c` with proper
  quoting (or use `shell: true` with a validated, quoted command line).
- **Done when:** A `.cmd` shim and a `.exe` both run `hemtt check` successfully.

<a id="hard-06"></a>

### HARD-06 — Diagnostics and error surfaces are inconsistent → `OPEN` (partial)

- **Progress:** the paths touched by the items above now follow the rule (link inspection errors,
  launch/stop failures, HEMTT shim resolution). The remaining `catch { }` blocks still need a pass.

- **Why:** Several `catch {}` blocks swallow failures with no output (e.g. `runtime.ts` `currentLinkTarget`,
  `extension.ts` Eden `getStatus` probe), while other paths show modal dialogs. Support reports become guesswork.
- **Where:** `src/**/*.ts`.
- **Do:** Adopt one rule: every caught error is either handled with a user-visible remedy or logged through `logError`
  with enough context. Add a short "Troubleshooting" table row for each new message.
- **Done when:** A grep for `catch {` / `catch (…) { }` finds only justified, commented cases.

<a id="hard-07"></a>

### HARD-07 — Dead code and duplicated API helpers → `DONE`

- **Done:** `api.evaluateCode` and `runtime.stopStaleArmaProcesses` deleted; `status.ts` uses an
  explicit `StatusTracker` (`createStatusTracker` / `defaultStatusTracker`) instead of module state.
  Remaining unused exports are tracked by grep in `TESTING.md` §1.

- **Why:** `src/api.ts` has `evaluateCode` duplicating `evalCode`; `stopStaleArmaProcesses` is named "stop" but only warns;
  `src/status.ts` keeps a module-level `processSeenAt` that makes the status text depend on activation history.
- **Where:** `src/api.ts`, `src/runtime.ts`, `src/status.ts`.
- **Do:** Remove or merge duplicates, rename misleading functions, and make `processSeenAt` part of an explicit
  tracker object instead of module state.
- **Done when:** `tsc --noUnusedLocals --noUnusedParameters` is clean and no unused exports remain (verify by grep, since
  TypeScript does not report unused exports).

---

<a id="sec-6"></a>

## 6. Marketplace listing and packaging (`PKG`)

<a id="pkg-01"></a>

### PKG-01 — `package.json` metadata for the gallery

- **Do:** Add and verify:
  - `keywords`, `galleryBanner`, `extensionKind` and `capabilities`, plus honest `categories`.
  - Pin `devDependencies["@types/vscode"]` to the minimum engine (`~1.99.0`).
- **Done when:** `vsce package` produces zero metadata warnings and the listing categories match the shipped features.
- **Progress:** `keywords`, `galleryBanner`, `extensionKind: ["workspace"]`, `capabilities` (untrusted/virtual
  workspaces) and `categories: ["AI", "Other"]` are done. `Programming Languages`, `Debuggers`, `Linters` and `Testing`
  were removed: there is no grammar, no debug adapter and no test integration, so the claims were not true.
  **Still open:** pin `devDependencies["@types/vscode"]` to `~1.99.0` (the engine floor) so `tsc` rejects APIs newer
  than the declared engine.
  **Done (with `ENG-04`):** pinned to `~1.99.0`; the lock was regenerated and `npm run compile` is clean against
  `@types/vscode` 1.99.1.

<a id="pkg-02"></a>

### PKG-02 — Marketplace readme quality

- **Do:** `README-MARKETPLACE.md` (packaged via `--readme-path`) needs, above the fold:
  1. one-line value proposition,
  2. a 20–40 s GIF of edit → save → change visible in Arma,
  3. 3–4 annotated screenshots (Arma Project view, Debug Console with watches, problems panel with HEMTT errors),
  4. an explicit requirements block (Windows x64, Arma 3, Arma 3 Tools recommended, HEMTT optional),
  5. a "What this does *not* do" block (no PBO packing for release, no multiplayer client attach, no Linux support).
  Keep images in `media/` and reference them relatively so they travel inside the `.vsix`.
- **Done when:** The readme renders correctly from the packaged `.vsix` (install it in a clean VS Code profile and open the
  extension page).

<a id="pkg-03"></a>

### PKG-03 — Packaging allow/deny list

- **Do:** Review `.vscodeignore`: confirm `examples/**` (needed by `scaffold.ts`) and `vscode-runtime/**` ship, and that
  `package-lock.json`, `*.vsix`, `*.zip`, dev scripts and `.vscode/**` do not.
- **Done when:** `npx @vscode/vsce ls` output is intentional line-by-line, and `.vsix` size is stable between builds
  (±1 %).

<a id="pkg-04"></a>

### PKG-04 — Repository hygiene

- **Do:** Decide whether built `.vsix`/`.zip` artifacts belong in git (they are already in `.gitignore` but older copies
  may still be tracked). If they are release outputs, keep them out of the source tree and attach them to GitHub Releases.

- **Done when:** `git ls-files` contains no build artifacts and a fresh clone + `build-all.ps1` reproduces the same vsix.

<a id="pkg-05"></a>

### PKG-05 — Publisher and listing assets

- **Do:** Verify the Marketplace publisher page (display name, logo, support link). Add a `QnA`/support pointer and a
  short privacy statement ("no telemetry; the local API is bound to 127.0.0.1 and does not phone home").
- **Done when:** The public listing shows a logo, a support link and a stated telemetry position.

---

<a id="sec-7"></a>

## 7. Documentation and settings contract (`DOC`)

<a id="doc-01"></a>

### DOC-01 — Settings table drift

- `README-FULL.md` (the settings table is in the full guide) lists only a subset of project settings. Missing from the table: `armaProfile`, `requestTimeout`,
  `notifyOnError`, `autoJunction`, `reloadOnSave`, `serverLaunchArguments`, `watchInterval`, `watchExpressions`,
  `createExampleWithMission`, `clearArmaMissionArtifacts`, `modTypes`, `externalMods`.
- **Do:** Generate the table from `PROJECT_SETTING_DEFAULTS` + `schemas/sqfReloader-settings.schema.json` (or add a
  verification script that fails when a default key is undocumented) so the three sources cannot drift.
- **Done when:** Every key in `PROJECT_SETTING_DEFAULTS` appears in the readme table and the schema, and a script enforces it.

<a id="doc-02"></a>

### DOC-02 — Incorrect setting scope statement → `DONE`

- **Done:** `README-FULL.md` now says four options (three link toggles + `arma3ToolsDirectory`), and
  the scope claim matches `package.json` (`window` for all three link toggles, `application` for the
  tools directory).

- The readme says `sqfReloader.localVariableLinks` is scoped to `resource`, but `package.json` declares `window`.
  It also says "Three user-level options" and then lists four.
- **Do:** Fix the text or change the scope deliberately; verify against `package.json`.

<a id="doc-03"></a>

### DOC-03 — Command name mismatches → `DONE`

- **Done:** the contributed title is now **SqfReloader: Create example mod** (parenthetical dropped)
  and all three readmes use that exact name; the Marketplace readme keeps its command table and
  gained the new **Start the guided tour** row.

- The readme and an in-product message refer to **Create example project**, while the contributed title is
  **Create example mod (try the reloader)**. (The **Shared Mod** mismatch is resolved: the command no longer exists in
  either place.)
- **Do:** Normalise command names in docs, messages and `package.json`; add the one-line command table to the
  Marketplace readme too.

<a id="doc-04"></a>

### DOC-04 — Document API and security behavior precisely

- **Do (when `DEF-01` lands):** In the API section, describe the token header, the 1 MB body cap, the fact that only one
  Arma instance can own the port, and that the port may silently move to the next free one. Update
  `examples/*.ps1` to read the token from `config.json`.
- **Do now:** the API section must state plainly that any page in the user's browser can reach the local API, and that
  it is unsupported to expose it (see `LIMITATIONS.md`).

<a id="doc-05"></a>

### DOC-05 — Troubleshooting parity

- **Do:** Add entries for: unsupported platform, workspace trust, port taken by another tool, `webview` not loading,
  HEMTT not found / `.cmd` shim, "Server mod was not launched", duplicate-function reload blocking.
- **Also:** `README.md`, `README-FULL.md` and `README-MARKETPLACE.md` must link [LIMITATIONS.md](./LIMITATIONS.md) so the support matrix is
  one click away, and the Marketplace readme needs a requirements block stating Windows support.

---

<a id="sec-8"></a>

## 8. Engineering infrastructure (`ENG`)

<a id="eng-01"></a>

### ENG-01 — Automated tests for pure logic

- **Why:** Everything is currently verified by hand (`scripts/verify-*.js`, PowerShell harness). Regressions in the
  parser-heavy code (`src/links.ts` ~1,300 lines, `src/arma.ts`, `src/pbo.ts`, `src/serverConfig.ts`,
  `src/projectSettings.ts`) are easy to introduce and expensive to find.
- **Do:** Add a runner (node's built-in `node:test` is enough; no new framework needed) with focused tests for:
  CfgFunctions/tag parsing, `$PBOPREFIX$` normalisation, SQF reference/hover extraction, `params` scope rules,
  `server.cfg` `hostname` detection, JSONC parsing, `deletedFunctionVariable`, port normalisation, and launch-argument
  quoting (paths with spaces and non-ASCII characters).
- **Done when:** `npm test` runs headless on Windows CI in < 30 s and fails on a deliberately broken parser change.

<a id="eng-02"></a>

### ENG-02 — CI pipeline

- **Do:** Add `.github/workflows/ci.yml` on `windows-latest`: `npm ci` → `npm run compile` → `npm test` →
  `npx @vscode/vsce ls` sanity check. Add a separate manually triggered `release.yml` that builds the DLL (needs .NET 10 +
  MSVC), packages the vsix, uploads it as an artifact, and publishes on tag with `VSCE_PAT`.
- **Done when:** A pull request shows a green check, and a tag produces a downloadable vsix.

<a id="eng-03"></a>

### ENG-03 — Lint/format baseline

- **Do:** Add ESLint (`@typescript-eslint`) with the existing strict TS settings plus `no-floating-promises` and
  `no-misused-promises` (the codebase is promise-heavy), and Prettier or the VS Code formatter settings committed.
  Fix the initial findings; keep the rule set small enough to stay green.
- **Done when:** `npm run lint` is clean and wired into CI.

<a id="eng-04"></a>

### ENG-04 — Version consistency check → `DONE`

- **Done:** `scripts/verify-version.js` (`npm run verify:version`) checks `package.json`,
  `package-lock.json` (top level and the `""` package entry), the `.csproj`, `BuildStamp.cs` and
  `CfgPatches` (`version`, `versionStr`, `versionAr[]`); `build-all.ps1` runs it before building.
  The same change fixed the version bump that had corrupted `package-lock.json`, and regenerated
  the lock with `@types/vscode` pinned to `~1.99.0` (also closes the last part of `PKG-01`).

- **Do:** `build-all.ps1` already updates `package.json`, `package-lock.json`, the `.csproj`, `BuildStamp.cs` and
  `CfgPatches`. Add a verification step that fails the build when those five disagree, and surface the component version
  in `SqfReloader: Check connection` output.
- **Done when:** Editing one version file by hand fails the build with a precise message.

<a id="eng-05"></a>

### ENG-05 — Smoke test on a clean machine

- **Do:** Keep a manual release checklist (this document's §3) and run it on a machine without a prior install, with a
  fresh VS Code profile. Record the result in `CHANGELOG.md`/release notes.
- **Done when:** The checklist is executed and attached to the release.

---

<a id="sec-9"></a>

## 9. Optional polish worth doing before launch (`POL`)

<a id="pol-01"></a>

### POL-01 — "SqfReloader: Doctor" command

One command that checks and reports: Arma install detection, Arma 3 Tools/AddonBuilder, runtime bundle presence,
junction/mission link health, API port availability, connected game callback, mod roles, HEMTT availability, and
VS Code platform/trust. Print to the output channel with a copy-friendly summary. This will absorb a large share of
first-week support questions.

<a id="pol-02"></a>

### POL-02 — First-run walkthrough → `DONE` (sidebar tour)

The tour ships as a checklist in the Arma Project view instead of `contributes.walkthroughs`: the
step completion has to be observed by the extension (launch, save/reload, debug console), which
the walkthrough API cannot do. See `src/tutorial.ts`, `src/projectViewHtml.ts` and
`TESTING.md` §2.1. The original `contributes.walkthroughs` idea stays optional; the notification
wording it replaced is gone.

- **Why (original):** first-run guidance lived in a notification whose wording
  ("Completed installing extension…") reads like a debug message.

<a id="pol-03"></a>

### POL-03 — Settings discoverability

Add `SqfReloader: Open project settings` and `SqfReloader: Open debug console` to the Command Palette, and a
`SqfReloader: Toggle HEMTT checks` action. Today these are only reachable through the view or the settings page.

<a id="pol-04"></a>

### POL-04 — Status bar interaction

Clicking the status item only starts Arma. Offer a `QuickPick` when a game is running (Reload all, Reload current,
Open debug console, Stop, Show output) so the primary workflow is one click away.

<a id="pol-05"></a>

### POL-05 — SQF header snippets

Ship snippets for a `params` header block, a `CfgFunctions` class, and an `fn_` file skeleton. Cheap, and it makes the
hover documentation feature useful immediately because new functions get headers.

<a id="pol-06"></a>

### POL-06 — Code lens "Reload this function"

A code lens on `fn_*.sqf` files showing the derived Arma variable and offering Reload — removes the need to remember the
context-menu command.

---

<a id="sec-10"></a>

## 10. Deferred — accepted for the first release (`DEF`)

Known problems that are deliberately **not** fixed before publishing. Each one must reappear in the release notes
(`CHANGELOG.md` → *Still missing*) and in [LIMITATIONS.md](./LIMITATIONS.md).

<a id="def-01"></a>

### DEF-01 — Local REST API hardening

- **Decision:** deferred by the author. The API stays usable without a token for the first release.
- **Residual risk:** `SqfReloaderExtension/src/Plugin/RestApiServer.cs` sends `Access-Control-Allow-Origin: *`, accepts
  any `POST` body without a token and reads it without a size cap. Any web page the user visits can therefore queue
  arbitrary SQF (fire-and-forget, `no-cors`) in a running game, and a large body can exhaust memory.
- **Current mitigation, such as it is:** the listener binds `127.0.0.1`, the readme warns not to expose it, and
  `LIMITATIONS.md` marks remote/web-page access as **Won't fix**.
- **When it is done, the plan is:**
  1. random per-install token in `%LOCALAPPDATA%\SqfReloader\config.json` (written by `writeApiConfig`, required by the
     DLL as `X-SqfReloader-Token` on every non-`GET /api/status` route, optional for one release for compatibility);
  2. 1 MB body cap → `413`, read through a bounded stream;
  3. `Content-Type: application/json` required on mutating routes;
  4. no wildcard CORS header;
  5. `Host` header limited to `127.0.0.1`/`localhost`;
  6. update `src/api.ts`, `examples/*.ps1`, `ApiDocs.cs` and the readme.
- **Done when:** `curl` without the header gets `401`, a 5 MB body gets `413`, a foreign-origin page cannot execute SQF,
  and the extension plus the PowerShell examples still work.

<a id="def-02"></a>

### DEF-02 — Multi-root workspaces (see also `HARD-04`)

Two Arma projects open side by side share settings and mod roles because `currentWorkspace()` returns folder 0.
Accepted for the first release; `LIMITATIONS.md` marks multi-root as **To be fixed**.

<a id="def-03"></a>

### DEF-03 — "Stop Arma 3" stops every Arma instance (see also `HARD-03`)

`taskkill /IM arma3_x64.exe /F` closes sessions the extension did not start. Accepted for the first release, with the
documented caveat in `LIMITATIONS.md`.

---

<a id="sec-11"></a>

## 11. Future backlog — explicitly *not* required for this release (`FUT`)

These are tracked so the first release stays small. None of them blocks publishing.


<a id="fut-01"></a>

### FUT-01 — SQF language support (grammar + IntelliSense)
Bundle a TextMate grammar (the `Programming Languages` category was dropped until one ships), then a real language
service: completion for commands/BIS functions, signature help, semantic tokens, SQF-aware diagnostics, and a formatter.
Largest single quality-of-life win for plugin developers.

<a id="fut-02"></a>

### FUT-02 — A real SQF debugger (DAP)
Breakpoints in `.sqf` mapped onto `SqfReloader_fnc_*` execution, call stack, locals/watch in a Variables view, stepping via
scheduled SQF. Requires cooperation from the DLL (pause/step hooks) and is the natural upgrade from the current
"Debug Console + watches".

<a id="fut-03"></a>

### FUT-03 — Test Explorer integration
Discover and run Arma unit tests (CBA/ACE-style or a project-defined runner) from the VS Code Test Explorer, with per-test
results, rerun-on-save and inline failure output. Builds on the mission/test scaffolding already present in
`examples/armaExamples/`.

<a id="fut-04"></a>

### FUT-04 — Multi-machine / remote workflows
Attaching to a dedicated server that is not on the same machine (authenticated, TLS optional), a "server" target selector,
and support for Remote-SSH/WSL where Arma runs on the host. Today there is exactly one local target and one port.

<a id="fut-05"></a>

### FUT-05 — Multi-root workspaces, first class
Independent settings, mod roles, links and reload state per workspace folder, plus per-folder status.

<a id="fut-06"></a>

### FUT-06 — Reload scope beyond functions
Hot-reload `config.cpp`/`CfgFunctions` changes without a mission restart, `description.ext` edits, and mission
`preInit`/`postInit` replay on **Reload and restart mission functions**.

<a id="fut-07"></a>

### FUT-07 — Change-aware reload
Reload everything that changed since the last successful reload or since a git baseline (`HEAD`), instead of "all" or
"current file". Add a "changes since baseline" panel entry.

<a id="fut-08"></a>

### FUT-08 — Release/packaging workflow inside VS Code
HEMTT `build`/`launch` integration, `$PBOPREFIX$` editor, PBO signing (`DSSignFile`) with key management, and a
Steam Workshop upload step. Today PBO staging exists only to make launches work; shipping is manual.

<a id="fut-09"></a>

### FUT-09 — MCP server / broader AI integration
Expose the SQF API as an MCP server so any agent (not only VS Code's `armaAiTool`) can read Arma context, RPT errors and
evaluate SQF. Add structured tools for "reload these functions", "list RPT errors since <time>", and "run this test mission".

<a id="fut-10"></a>

### FUT-10 — RPT and log tooling
Clickable `File <path>, line N` links from the RPT into the editor, an error timeline, deduplication across restarts, and
export of a redacted support bundle.

<a id="fut-11"></a>

### FUT-11 — Live performance insight
Per-function reload timings, compile-time warnings surfaced as diagnostics with quick fixes (e.g. missing `params`
header, unused private variable — beyond what HEMTT reports).

<a id="fut-12"></a>

### FUT-12 — Opt-in telemetry and crash reporting
Only if it can be genuinely opt-in and documented; today the plan is "no telemetry" and the listing should say so.

<a id="fut-13"></a>

### FUT-13 — Localisation
Extract user-facing strings with `vscode.l10n` (`package.json` `l10n` + `@vscode/l10n-dev`). Worth doing once the UI text
stabilises after the first release.

<a id="fut-14"></a>

### FUT-14 — Mission and mod scaffolding gallery
More than one example template: mission with CfgRemoteExec variants, a CBA-based addon, a headless server template, and a
"convert existing mod" wizard.

<a id="fut-15"></a>

### FUT-15 — Broader Arma family support
Evaluate Arma Reforger/Enfusion workflows. Out of scope until the Arma 3 experience is stable.

<a id="fut-16"></a>

### FUT-16 — Function knowledge base: Wiki hover docs + single-file PBO sources

A local, versioned database of Arma functions so the editor stops being blind to everything outside the workspace:
hovering `BIS_fnc_objectsGrabber` (or any `TAG_fnc_*`) shows the Wiki description, syntax, parameters, return value,
examples and "since Arma 3 x.yy"; Ctrl+click opens the *one* source file out of the official PBO
(`Addons\3den.pbo` → `Functions\fn_3DENControlsHint.sqf`) without unpacking the addon, and hovering a function of a
loaded community mod shows that mod's own header documentation.

Four producers feed one lookup service:

1. **Offline PBO index** — every `Addons\*.pbo` header is read (no extraction) and mapped to a prefix-qualified path
   (`\a3\3den\functions\fn_*.sqf`) with the byte range of the file, so a source is a single `read` on demand.
2. **Runtime config index** — `CfgFunctions` is enumerated through the existing `POST /api/eval` bridge, which yields
   the tag, category, `file`, `ext`, `recompile`, `preInit` and `postInit` of every function the running game (and its
   loaded mods) really has. This is also the "which functions are new" detector.
3. **Wiki snapshot** — page wikitext ingested through the Wiki's MediaWiki API; the `{{RV}}` template is structured,
   so the parse is mechanical rather than scraping prose.
4. **Community headers** — headers of loaded mods' `fn_*.sqf`, parsed with the existing `parseHeader` /
   `describeParameters` in `src/links.ts`.

Everything is stored under `context.globalStorageUri`, keyed by Arma build plus a hash of the `Addons` folder, so a
game update (or a different set of loaded mods) rebuilds only the affected parts. `SqfSymbolLookup` consults the
database as a **fallback** — workspace definitions always win — and a read-only virtual document provider makes the
extracted BIS file openable from Ctrl+click, peek and "Find All References".

Nothing here blocks activation and nothing is fetched unless the user asks: the PBO index is offline, the wiki
snapshot comes from the `.vsix` when licensing allows it (otherwise it is built locally on request), and the game
query only runs once a connection exists.

Implementation plan, schemas, phases, risks and verification: **§14**.

---

<a id="sec-12"></a>

## 12. Suggested execution order

1. **Listing (blocks publishing):** `REL-01` — publisher/`VSCE_PAT` check, screenshots/GIF, support link,
   privacy statement; `PKG-01` (`@types/vscode` pin), `PKG-02`…`PKG-05`, `DOC-01`…`DOC-05`.
2. **Stability (before or shortly after the first release):** `HARD-01` (idle-aware polling), `HARD-02` (settings
   cache), `HARD-05` (HEMTT shim), `HARD-06`, `HARD-07`. `HARD-03`/`HARD-04` only if `DEF-02`/`DEF-03` are pulled
   forward.
3. **Infrastructure:** `ENG-01`…`ENG-05`, then `POL-01`…`POL-03` if time allows.
4. **Release gate:** run §3 on a clean machine, verify `vsce ls` output, then publish.
5. **After the release, in this order:** `FUT-16` phase 1 (offline PBO index, internal) → phase 2 (`CfgFunctions`
   enumeration; Ctrl+click opens the BIS source, hover shows the config facts) → phase 3 (wiki snapshot and the full
   documentation hover) → phase 4 (community headers) → phase 5 (polish). Phase 2 already answers "where is this BIS
   function defined?" for every function the game has, so it is worth shipping before the wiki licensing question
   (§13) is settled.

---

<a id="sec-13"></a>

## 13. Decisions and open questions

### Decided

1. **Versioning:** the extension stays on the fast `3.8.x` beta numbering while development is rapid. The first public
   Marketplace release restarts at **`1.0.0`** (no `4.0.0`). `CHANGELOG.md` records this.
2. **Language contribution:** `Programming Languages` was removed from `categories`; a TextMate grammar and language
   server stay in the backlog as `FUT-01`. Use a dedicated SQF grammar extension in the meantime — the navigation
   providers here do not depend on it.
3. **Remote support:** explicitly unsupported for the first release. `extensionKind` is `["workspace"]`, activation
   refuses non-Windows hosts, and `LIMITATIONS.md` documents working / *should work* / *to be fixed* / *won't fix*
   per environment and per feature.
5. **Local API hardening:** deferred (`DEF-01`); remote and web-page access are **Won't fix** in `LIMITATIONS.md` until
   it lands.

### Still open

1. **API token compatibility (for `DEF-01`):** is one release of "token optional" acceptable, or must every existing
   client be updated in lockstep?
2. **Multi-root and Stop-Arma scope:** pull `DEF-02`/`DEF-03` forward before `1.0.0`, or ship them documented?
3. **Wiki licensing for `FUT-16`:** `meta=siteinfo&siprop=rightsinfo` returns an **empty** licence for
   `community.bistudio.com`, and the rendered page is behind a Cloudflare challenge. Either (a) the extension builds
   the database on the user's machine from the public API, caches it locally, and always links the page with
   attribution — nothing is redistributed — or (b) written permission is obtained to ship a generated snapshot in the
   `.vsix`. Until that is answered, phase 3 ships the *local-cache* variant and the bundled snapshot stays out.
4. **`FUT-16` scope of the first version:** functions only (`CfgFunctions`), or also scripting commands
   (`setPos`, `call`, …) so hover works on both halves of SQF? Commands need the same pipeline but a different
   category (`Category:Arma 3: Scripting Commands`) and a different game source (engine, not a PBO), which roughly
   doubles phase 3 while `FUT-01` would then cover completion too.

---

<a id="sec-14"></a>

## 14. Design appendix — function knowledge base (`FUT-16`)

Written to be executed in small, independently shippable phases. Nothing here is required for the first public
release; the appendix exists so the work does not restart from zero later.

<a id="app-14-1"></a>

### 14.1 Goals and non-goals

**Goals**

- Hovering any `TAG_fnc_name` shows description, syntax line(s), parameters (name / type / description / optional /
  default), return value, examples, "since Arma 3 x.yy", and a link to the Wiki page.
- Ctrl+click on a BIS function opens its real source from the official PBO, read-only, without unpacking the PBO and
  without writing into the Arma installation.
- Works for functions the workspace does not contain and for functions declared by *loaded* community mods.
- Works offline; never blocks activation; never fetches anything unless the user asked (or once, with consent).
- Rebuilds itself when the Arma build or the `Addons` folder changes, and reports functions that appeared or
  disappeared since the last build.

**Non-goals**

- A full SQF language server (`FUT-01`): no completion, signature help, semantic tokens or formatter.
- Scripting *command* documentation (`setPos`, `call`) — the pipeline can feed it later, but v1 indexes
  `CfgFunctions` only (see §13 open question 4).
- Unpacking whole addons, editing PBOs or signing them (`FUT-08`).
- Names that only exist as strings at runtime (`call compile format [...]`, `missionNamespace getVariable "X"`).

<a id="app-14-2"></a>

### 14.2 Measured facts (2026-11-12, Arma 3 `2.22.0.154089`)

Measured on this machine with throwaway Node scripts (no dependency added) so the estimates below are facts, not
guesses. They are from **one** install and **one** game build; re-measure if the numbers decide a design choice.

**PBO side**

| Measurement | Result |
| --- | --- |
| `Addons\*.pbo` | 196 files, 15.5 GB total |
| Header scan with an incrementally grown buffer (256 KB steps) | **54 ms** for all 196: 3.4 MB of header, largest 194 KB (`anims_f_data.pbo`) |
| Same scan with a flat 4 MB read per file | 12 s — do not read a fixed prefix, grow the buffer until the entry list terminates |
| Entries / `*.sqf` entries | 58 817 / 2 804 (all 2 804 prefix-qualified paths unique) |
| Compiled companions | 1 295 `*.sqfc` entries, but **every** `.sqfc` has a `.sqf` sibling (0 orphans) → `.sqfc` can be skipped entirely |
| Compression | official PBOs use **none** (mime bytes `00 00 00 00`); `Cprs` never appears |
| Extension block | every PBO starts `\0sreV` + 16 zero bytes, then `prefix` / `product` / `version` name-value pairs; `prefix` is present in all 196 (`a3\3den`, `a3\functions_f`, …) |
| Data section | starts at `headerEnd + 20` (SHA-1 checksum); entry data is contiguous in entry order with `dataSize` bytes each; 21 bytes of trailer after the last entry |
| Entry record | `name\0` + 20 bytes (`mime` 4, `originalSize` 4, `offset` 4, `timestamp` 4, `dataSize` 4); for uncompressed entries `originalSize` and `offset` are 0, so the running position must be accumulated in entry order |
| Verified extraction | `3den.pbo` → `Functions\fn_3DENControlsHint.sqf` (13 658 B) sliced byte-exact; `\a3\3den\functions\fn_3dencontrolshint.sqf` resolves from the extension `prefix` |

**Wiki side**

| Measurement | Result |
| --- | --- |
| API | `https://community.bistudio.com/wikidata/api.php` (MediaWiki 1.39.0); **`/wiki/api.php` and rendered pages answer `403` (Cloudflare)** |
| Pages | 2 062 in `Category:Arma 3: Functions`; also `Arma 3: New Functions`, `New Functions List`, `Scripting Commands` |
| Titles | spaces, not underscores (`BIS fnc objectsGrabber`) — normalise when matching |
| Content access | `action=query&prop=revisions&rvprop=content|timestamp&rvslots=main&titles=A|B|…` returns raw wikitext (50 titles per call) |
| Template | `{{RV|type=function|game1=arma2|version1=1.00|…|game4=arma3|version4=0.50|gr1=…|descr=…|s1=…|p1=…|p2=…|p3=…|r1=…|x1=<sqf>…</sqf>|x2=…|seealso=…}}` |
| Size | ~450 B average over the sampled 500 pages (many are one-line stubs); real pages are 1–6 KB → the whole snapshot is a few MB |
| Rate limiting | Cloudflare returns intermittent `403 "Just a moment…"` on bursty requests; batched calls with 3 → 48 s backoff recover, HTML pages stay blocked |

**Consequences**

- The offline index is cheap enough to rebuild whenever the `Addons` signature changes; no complex cache
  invalidation is needed.
- Source navigation needs **no** third-party PBO library and **no** Arma 3 Tools; ~150 lines of TypeScript suffice.
  `Cprs`/LZSS is only needed for community PBOs and can land later behind a size cap and a clear error.
- Wiki ingestion must be paced, batched and retried through the API, never through the HTML page.

<a id="app-14-3"></a>

### 14.3 Architecture

```
  Arma 3 install ── Addons\*.pbo headers ──────────────► PboIndex        (offline, 54 ms)
                 ── arma3_x64.exe product version ─────► IndexKey {version, addonsHash}
  Running game   ── CfgFunctions enumeration ──────────► ConfigIndex     (POST /api/eval, per tag)
  Wiki           ── MediaWiki API snapshot ────────────► WikiSnapshot    (cached locally, or refreshed)
  Loaded mods    ── fn_*.sqf headers ──────────────────► CommunityDocs   (parseHeader)
                                   │
                                   ▼
                  FunctionKnowledge — one lookup service
                    byName("bis_fnc_objectsgrabber")  -> FunctionDoc
                    byPath("\a3\3den\functions\…sqf") -> FunctionDoc + PboEntry
                                   │
        ┌──────────────────────────┼───────────────────────────┐
        ▼                          ▼                           ▼
  SqfSymbolLookup          PboSourceProvider             Commands / armaAiTool
  (hover + definition)     (read-only virtual document)  (rebuild, report, wiki page)
```

One hover source per word: the database is injected into `SqfSymbolLookup` as a *fallback*, not registered as a
second `HoverProvider`, so VS Code can never show two competing hovers for the same identifier.

<a id="app-14-4"></a>

### 14.4 Module layout

Follows the existing split-by-responsibility convention and keeps public exports stable (`AGENTS.md`).

| File | Responsibility | Exports |
| --- | --- | --- |
| `src/pboIndex.ts` | PBO header reader (Vers block, entry records), single-entry extraction, `Addons` signature hash, per-PBO `dataStart` precomputation. Pure Node `fs`, no `vscode`. | `readPboHeader`, `indexAddons`, `extractPboEntry`, `addonsSignature`, types `PboEntry` / `PboIndex` |
| `src/lzss.ts` | `Cprs` decoder for compressed community entries (4 KB ring buffer). Only needed from phase 4. | `decompressCprs` |
| `src/functionStore.ts` | `globalStorageUri` layout, gzip JSON read/write, atomic replace, manifest + schema migration, old-key cleanup. | `FunctionStore`, `STORAGE_SCHEMA` |
| `src/functionDocs.ts` | The lookup service and the hover renderer: name/path indexes, lazy shard loading, Wiki `{{RV}}` → `FunctionDoc` mapping, markdown assembly + size caps. | `FunctionKnowledge`, `formatFunctionHover`, `FunctionDoc` |
| `src/functionIndex.ts` | Orchestration: version/addon key, SQF `CfgFunctions` enumeration and result parsing, join with PBO/wiki/community data, new-vs-removed diff. | `buildFunctionIndex`, `enumerateCfgFunctions`, `diffFunctionNames` |
| `src/wikiClient.ts` | Batched, paced, retrying MediaWiki fetcher (Node `https`), plus the `{{RV}}` wikitext parser. Used by the build script and by an opt-in runtime refresh. | `fetchFunctionPages`, `parseRvTemplate` |
| `src/pboSource.ts` | `TextDocumentContentProvider` for `sqfreloader-pbo:` URIs, optional on-disk cache, `openFunctionSource` command. | `PboSourceProvider`, `PBO_SCHEME` |
| `src/functionDiagnostics.ts` | Optional "unknown function" hints (phase 5), reusing the argument-scanning helpers already in `links.ts`. | `UnknownFunctionDiagnostics` |
| `scripts/build-function-db.js` | Release-time generator: PBO map + wiki snapshot into `data/function-db/`, invoked from `build-all.ps1` only when `--with-wiki` is passed. | — |
| `src/links.ts` (edit) | Accept an optional `FunctionKnowledge`; use it in `resolveFunction` / `provideHover` when the workspace index misses. | unchanged exports |
| `src/extension.ts` (edit) | Construct the service after the activation guard, register the provider, commands and settings watcher, defer the index build. | unchanged exports |
| `src/settings.ts` (edit) | New settings in `Settings` + `readSettings`. | unchanged exports |
| `package.json` (edit) | `contributes.configuration` entries, commands; nothing under `data/` is currently excluded by `.vscodeignore`, so the packaged snapshot only needs a `vsce ls` check. | — |
| `schemas/sqfReloader-settings.schema.json` (edit) | Project-level options only (per-project `functionDocs.includeCommunity`). | — |

Nothing new is added to `src/api.ts`: `evalCode` already returns `text` (Arma's `str` output), which is all the
enumeration needs.

<a id="app-14-5"></a>

### 14.5 Storage layout and schemas

`FunctionStore` owns `context.globalStorageUri` (never the workspace, never the Arma folder):

```
<globalStorage>/functiondb/
  manifest.json                      { schema: 1, generator: "<extension version>", arma: { version, build },
                                       addonsHash, builtAt, wiki: { snapshot, source: "bundled"|"fetched", fetchedAt } }
  pbo/<addonsHash>.json.gz           { pbos: [{ file, prefix, entries: [{ path, dataStart, size }] }] }
  bis/names.json.gz                  { "bis_fnc_objectsgrabber": "BIS", ... }        // ~2 000 keys, loaded eagerly
  bis/doc-<tag>.json.gz              [FunctionDoc]                                   // lazy per tag
  community/<workspaceKey>.json.gz   [FunctionDoc]
  cache/<addonsHash>/<pbo>/<path>    extracted sources (only when extractSources is on)
```

- `addonsHash` = SHA-1 of `name|size|mtime` for every `Addons\*.pbo` (196 `stat` calls, sub-millisecond).
- `workspaceKey` = first 8 hex characters of the SHA-1 of the normalised workspace folders.
- Only `*.sqf` entries are indexed: 2 804 rows ≈ 300 KB raw / ~60 KB gzipped (the 1 295 `*.sqfc` compiled
  companions are skipped — every one has a `.sqf` sibling). A config `file` pointing at `.cpp` simply has no source
  link.
- Writes go to `<file>.tmp` then `fs.renameSync`, and the previous manifest is kept until the new DB is complete, so a
  crash mid-build leaves a working database.

```ts
interface FunctionDoc {
    name: string;                 // BIS_fnc_objectsGrabber (game variable name)
    kind: "bis" | "community";
    tag?: string;                 // CfgFunctions tag: BIS, BIN, ACE, …
    category?: string;            // CfgFunctions category
    description?: string;         // markdown-lite, Wiki or file header
    syntax: string[];             // one entry per {{RV}} sN
    parameters: { name: string; type?: string; description?: string; optional?: boolean; default?: string }[];
    returns: { type?: string; description?: string }[];
    examples: string[];           // plain SQF, un-fenced
    seeAlso: string[];
    group?: string;               // {{RV}} gr1
    since?: { game: string; version: string }[];   // game4=arma3 / version4=0.50
    wikiUrl?: string;
    wikiRevision?: string;        // ISO timestamp of the page revision
    path?: string;                // \a3\3den\functions\fn_3DENControlsHint.sqf
    pbo?: { file: string; entry: string; dataStart: number; size: number; mime: string };
    config?: { file?: string; ext?: string; recompile?: boolean; preInit?: boolean; postInit?: boolean };
    source?: "wiki" | "header";
}

interface PboEntry { path: string; dataStart: number; size: number; }
```

<a id="app-14-6"></a>

### 14.6 Pipelines

**A. Offline PBO index (`indexAddons`)**

1. `readdir` `Addons` for `*.pbo`; `stat` each into the `addonsHash`.
2. Open each PBO, grow a 256 KB buffer until the entry list terminates, return `headerEnd` and the entry list.
3. Keep only `*.sqf` (skip `*.sqfc`); prefix each with the `prefix` extension value (`a3\3den` → `\a3\3den\...`) and
   normalise separators and case for lookup.
4. Store `dataStart = headerEnd + 20 + Σ previous dataSize` **in the index**, so extraction later is one `read`.
5. `extractPboEntry`: bounds-check (`dataStart + size <= stat.size`), cap size (2 MB for `.sqf`), reject `..` in the
   entry path before using it as a cache file name, `fs.readSync` exactly that range. `Cprs` entries go through
   `lzss.ts` and are written with `originalSize` bytes.

**B. Runtime `CfgFunctions` enumeration (`enumerateCfgFunctions`)**

1. Ask for the tag list first (small response):
   `str (("true" configClasses (configFile >> "CfgFunctions")) apply { configName _x })`.
2. Then one `evalCode` per tag, so no single response is large and a huge mod list cannot hit a timeout:

```sqf
private _out = [];
{
    private _category = _x;
    private _file = getText (_category >> "file");
    {
        _out pushBack [
            configName _category,
            configName _x,
            _file,
            getNumber (_x >> "recompile"),
            getText (_x >> "ext"),
            getNumber (_x >> "preInit"),
            getNumber (_x >> "postInit")
        ];
    } forEach ("true" configClasses _category);
} forEach ("true" configClasses (configFile >> "CfgFunctions" >> "TAG"));
str _out
```

3. Parse the `str` output with a small SQF-literal reader (nested arrays, quoted strings, numbers). Prefer this over
   `toJSON`, which needs a newer build and has its own escaping pitfalls.
4. Cache per `addonsHash`: the in-game config and the on-disk PBOs must describe the same build, otherwise the join
   is meaningless. If the game is running from a different install than the detected one, skip with a log line.
5. Run once per key, deferred after activation, only when `getStatus()` reports `gameConnected`.

**C. Wiki snapshot (`wikiClient` + `parseRvTemplate`)**

1. Enumerate `Category:Arma 3: Functions` (500 per call, paginate with `cmcontinue`).
2. Fetch content 50 titles per call with a descriptive `User-Agent`, ≥ 700 ms between calls, retry `403` with
   3 → 6 → 12 → 24 → 48 s backoff, then give up and record the titles as `missing`.
3. Parse the `{{RV}}` template with a brace/pipe-aware scanner (not a flat regex): `descr`, `s1..sN`, `p1..pN`,
   `r1..rN`, `x1..xN`, `seealso`, `gr1`, `gameN`/`versionN`. Strip wiki markup that means nothing in a hover
   (`[[A|B]]` → `B`, `[[A]]` → `A`, `'''bold'''` → `**bold**`, `<sqf>…</sqf>` → plain SQF, `<br>` → newline) and
   keep unknown constructs as literal text.
4. Normalise the title to the variable name (`BIS fnc objectsGrabber` → `bis_fnc_objectsgrabber`) and record
   `wikiRevision`.
5. Store as `bis/doc-<tag>.json.gz` after the join with the config index (tag comes from the game, not the title).

**D. Community headers**

1. From the config index take every function whose tag is not a BIS/BIN/A3 tag.
2. Resolve `config.file` (`\z\ace\addons\…`) against, in order: `workspaceAddons()` sources, `configuredExternalMods()`
   folders, the Arma `Addons` folder, and any `-mod=` folder already known to the launcher.
3. If the source is a loose file, run `formatDocumentation(file)`; if it is inside a PBO, index that PBO on demand
   (`indexAddons` accepts a directory list, not only the install) and extract the single entry, then run the same
   formatter on the text.
4. Guessed parameters from `describeParameters` are marked "inferred from `params`" so they are not confused with a
   documented header.

**E. Refresh, diff and cleanup**

- Trigger: activation (deferred ~5 s), the `sqfReloader.rebuildFunctionIndex` command, or the first successful
  connection after an Arma update.
- Steps: compute key → rebuild the PBO part if `pbo/<key>.json.gz` is missing → ensure the wiki part → enumerate when
  connected → join → write `bis/doc-*.json.gz` + `manifest.json` → delete other `addonsHash` directories.
- Diff the new name set against the previous manifest: `N added, M removed (Arma 3 <version>)` in the output channel,
  plus a one-time toast when `N > 0`. Store `notInGame` (Wiki has it, this build does not — e.g. removed functions)
  and `notInWiki` (new functions documented only in config) and surface both through the report command.

<a id="app-14-7"></a>

### 14.7 Hover and navigation UX

Example hover for a BIS function (kept under ~4 KB; each example capped at 5 lines):

````markdown
```sqf
[position, size, objectOrientation] call BIS_fnc_objectsGrabber
```

Converts a set of placed objects to an object array for the DynO mapper.

| # | Parameter | Type | Description |
| - | --- | --- | --- |
| 1 | `position` | Position | *(optional, `[0,0]`)* centre of the grabbing area |
| 2 | `size` | Number | *(optional, `50`)* radius of the grabbing area |
| 3 | `objectOrientation` | Boolean | *(optional, `false`)* capture object orientation |

**Returns** `String` — `[classname, relPos, azimuth, fuel, damage, pitchBankResult, vehicleVarName, initCommands, simulationEnabled, isASL]`

**Example**
```sqf
[getPos player, 20, true] call BIS_fnc_objectsGrabber;
```

[BIS_fnc_objectsGrabber on the Wiki ↗](https://community.bistudio.com/wiki/BIS_fnc_objectsGrabber) · since Arma 3 0.50 · `\a3\functions_f\spawning\fn_objectsGrabber.sqf` · *Alt+Click for source*
````

Rules:

- Workspace definition wins; the database is only consulted when `resolveFunction` misses. The hover footer says
  which side the answer came from (`wiki`, `CfgFunctions`, `header`).
- Parameters without a Wiki entry fall back to the header's `params` list, then to `config.file` only — never invent
  a type.
- `MarkdownString.isTrusted` is enabled only for the extension's own `command:` links; the Wiki link is plain
  `https:`. Command arguments are passed as one JSON string (`{"name":"BIS_fnc_…"}`) so a name can never inject
  markdown or a second command.
- Definition (`F12` / Ctrl+click) returns a `Location` in the `sqfreloader-pbo:` virtual document, so peek opens in
  place. With `sqfReloader.functionDocs.extractSources` the file is also written once to the cache and opened as a
  real read-only file, which makes folding, "Find All References" and language features work on it.
- A `when` clause keeps the fallback off for non-`fnc` identifiers, so hovering a normal variable never pays for a
  database lookup.
- Unresolvable source (unknown PBO, `Cprs` before phase 4, unloaded mod): hover still shows the Wiki/config part and
  says "source not available — PBO not found in this installation".

<a id="app-14-8"></a>

### 14.8 Settings and commands

| Setting | Default | Meaning |
| --- | --- | --- |
| `sqfReloader.functionDocs.enabled` | `true` | Master switch for wiki/config hover and BIS source navigation. |
| `sqfReloader.functionDocs.wikiSource` | `"bundled"` (see §13 open question 3; `"local"` is the interim default while licensing is unresolved) | `bundled` uses the snapshot in the `.vsix`; `local` builds it on this machine from the public API (paced, once) and caches it; `off` disables wiki text but keeps config/PBO data. |
| `sqfReloader.functionDocs.includeCommunity` | `true` (project setting too) | Also index functions of loaded third-party mods. |
| `sqfReloader.functionDocs.extractSources` | `false` | Write extracted BIS sources to the cache and open them as real files instead of virtual documents. |
| `sqfReloader.functionDocs.unknownDiagnostics` | `"off"` | `off` / `hint` / `warning`: flag `TAG_fnc_*` names that exist neither in the workspace nor in the database. Off by default because runtime-created functions and `compile`-loaded names would otherwise produce false positives. |

Every setting goes into `package.json` → `contributes.configuration` (today `functionLinks`,
`globalVariableLinks` and `localVariableLinks` are read by code but **not** declared — do not repeat that mistake),
plus the settings table in `README-FULL.md`. Only `functionDocs.includeCommunity` is also accepted in
`.vscode/sqfReloader-settings.json` (per-project behaviour) and therefore in the JSON schema.

Commands (all in the `SqfReloader` category):

- `sqfReloader.rebuildFunctionIndex` — rebuild now, showing progress and the `added/removed` summary.
- `sqfReloader.openFunctionSource` — internal, invoked from hover/definition links (args: `{"name": …}`).
- `sqfReloader.openFunctionWiki` — open the page of the function under the cursor.
- `sqfReloader.reportUnknownFunctions` — markdown report of `notInGame` / `notInWiki` / unknown-in-editor names in
  a read-only virtual document (same provider, `sqfreloader-report:` scheme or a temp file).
- `sqfReloader.clearFunctionCache` — delete `functiondb/` (useful when testing the rebuild path).
- Optional (phase 5): `sqfReloader.searchFunctions` quick pick over `bis/names.json.gz`.

<a id="app-14-9"></a>

### 14.9 Phases

Each phase is a shippable increment with its own `CHANGELOG.md` entry, except P1, which is groundwork and stays
internal until P2 makes it reachable from the editor. P3 only needs the wiki + PBO parts, so it can be moved ahead of
P2 if the function-name enumeration turns out to be the slower piece.

**P1 — Offline PBO index + extractor** (`pboIndex.ts`, `lzss.ts` stub, unit fixtures)
The header reader, the `Addons` signature and a byte-exact single-entry extractor. No user-facing surface yet; a
temporary `sqfReloader.openFunctionSource` takes a path argument so the phase can be checked by hand.
- Done when: `\a3\3den\functions\fn_3dencontrolshint.sqf` extracts with the right size and content, the full install
  indexes in < 300 ms cold / < 20 ms warm, the traversal and bounds fixtures in `scripts/verify-pbo-index.js` fail
  as expected, and no whole-PBO read ever happens.

**P2 — `CfgFunctions` enumeration, join and source navigation** (`functionIndex.ts`, `functionStore.ts`,
`pboSource.ts`, `links.ts`)
The database knows every function the running game has (`tag`, `category`, `file`, `ext`, `recompile`, `preInit`,
`postInit`), joins it with the PBO index, rebuilds on a version/addons change, logs added/removed, and Ctrl+click on a
BIS name opens the extracted source; hover shows the config facts.
- Done when: with the game running, the rebuild completes in < 2 s, the per-tag counts match
  `("true" configClasses (configFile >> "CfgFunctions"))`, changing the Arma build (or deleting `manifest.json`)
  triggers exactly one rebuild, `BIS_fnc_3DENCamera` Ctrl+clicks to `Functions\fn_3DENCamera.sqf`, and the source is
  read-only and identical to the PBO entry byte-for-byte.

**P3 — Wiki snapshot + documentation hover** (`functionDocs.ts`, `wikiClient.ts`, `scripts/build-function-db.js`)
Hover shows description, syntax, parameters, returns, examples and the Wiki link, sourced from a snapshot that covers
every page in the category that parses.
- Done when: `BIS_fnc_objectsGrabber` renders the page content (checked against two other pages sampled by eye),
  warm hover is < 30 ms and the first hover < 300 ms, a page whose template is unparseable degrades to a link
  instead of throwing, and `scripts/verify-function-db.js` fails the build when > 2 % of pages stop parsing.

**P4 — Community mods** (`functionIndex.ts` join, `lzss.ts`, `functionDocs.ts`)
Functions of loaded mods get header documentation and a source link, including PBO-internal sources.
- Done when: an ACE/CBA function hover shows its header, its CfgFunctions facts and opens its source from the mod
  PBO; a `Cprs` entry decompresses correctly (checked against a known file hash); an unreachable mod degrades with a
  message, not an error.

**P5 — Polish** (`functionDiagnostics.ts`, `armaAiTool.ts`, search)
Opt-in unknown-function hints, the report command, a function search quick pick, and a read-only
`listArmaFunctions`/`getArmaFunction` capability for the language-model tool so the AI sees the same documentation.
- Done when: hints can be turned on/off without a reload, the report lists the three name sets, and the tool answers
  a function lookup without the game running.

<a id="app-14-10"></a>

### 14.10 Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Cloudflare `403` on Wiki requests (measured, intermittent) | A refresh can stall | Batch 50 titles, pace, backoff to 48 s, resume from `cmcontinue`, mark failures and keep the previous snapshot. Never fetch at activation; only on the user's command. |
| Wiki licensing is undeclared (`rightsinfo` empty) | Cannot redistribute page text | Default to a locally built cache with attribution and a link; bundle only after written permission (§13 open question 3). |
| Wiki template drift (`{{RV}}` → `{{Function}}` etc.) | Wrong or empty hovers | Parser accepts both, falls back to the page link, and `scripts/verify-function-db.js` fails the build when > 2 % of pages stop parsing. |
| Game not running / different install | Config index missing or wrong | Build hover from the Wiki + PBO parts alone; only join config facts when the running install matches the detected one. |
| `Cprs` compressed community PBOs | No source for some mods | Phase 4 LZSS decoder, 2 MB cap, explicit "compressed entry not supported" until then. |
| Hover latency in large workspaces | Feels slow | Eager `names.json.gz` (~2 000 keys), lazy tag shards, no database work for non-`fnc` words, warm-path cache of the last N hovers. |
| Large eval responses / `runTimeout` | Enumeration fails on huge mod sets | One request per tag, parse `str` with a tolerant reader, skip and log the tag that exceeds the timeout. |
| Storage growth | Wasted disk | Only `*.sqf` rows + gzipped shards; delete other `addonsHash` directories; `cache/` is disposable and capped. |
| Path traversal from PBO entry names | Writing outside the cache | Reject `..` / absolute entry paths before composing cache paths; the virtual document never touches disk. |
| Activation cost on startup | Slower activation | Build is deferred, cancellable, and skipped entirely when `functionDocs.enabled` is `false`. |

<a id="app-14-11"></a>

### 14.11 Verification

```powershell
npm run clean ; npm run compile
node scripts/verify-pbo-index.js        # synthetic PBO fixtures: Vers block, raw + Cprs entries, bounds, traversal
node scripts/verify-function-db.js      # wikitext samples -> FunctionDoc; build fails when parsing regresses
node scripts/verify-function-hover.js   # vscode-stub harness: hover/definition for a BIS name, no workspace match
npx --no-install @vscode/vsce ls        # data/function-db/** present, no dev files, no stale shards
```

`scripts/verify-pbo-index.js` uses generated fixtures (a hand-written PBO with a known payload) so it runs without an
Arma installation; an optional `--arma <dir>` mode validates the same code against real `Addons\*.pbo` (2 804 `.sqf`
entries and the `fn_3DENControlsHint.sqf` byte comparison). `scripts/verify-function-hover.js` reuses
`scripts/vscode-stub.js` the way the other stubs do: set `workspace.workspaceFolders`, point the store at a temp
directory, then call `provideHover`/`provideDefinition`. Add all three to the verification list in `AGENTS.md`.

<a id="app-14-12"></a>

### 14.12 Documentation duties when this lands

- `README-FULL.md` — a "Function documentation and BIS sources" section: what hover shows, how Ctrl+click opens a
  PBO file, where the database lives, how to rebuild it, and the settings table rows.
- `README-MARKETPLACE.md` + `README.md` — one bullet each ("Hover any `BIS_fnc_*` for syntax/parameters; Ctrl+click
  opens the official source without unpacking a PBO").
- `LIMITATIONS.md` — replace/extend the "Ctrl+click / hover on `TAG_fnc_name`" row and add rows for: BIS source
  navigation (**Working**, read-only, official `Addons` only), compressed `Cprs` entries (**Should work** after
  phase 4), functions of unloaded mods (**Won't fix**: the game must have them loaded to be indexed), wiki refresh
  offline (**Won't fix**: needs a network), hover for non-`fnc` identifiers (**Won't fix** until `FUT-01`).
- `CHANGELOG.md` — one `Added` entry per phase under `Unreleased`.
- `AGENTS.md` — add the new modules to the read-first list (`pboIndex.ts`, `functionDocs.ts`, `functionIndex.ts`,
  `pboSource.ts`, `functionStore.ts`) and the new verify scripts to `## Verification`.
- `LIMITATIONS.md`/§13 — close or restate open question 3 once the licensing answer is known.
