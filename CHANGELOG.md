# Changelog

All notable changes to **Arma 3 SQF Reloader** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the extension is in **beta**
the version numbers move quickly (`3.8.x`); the first public Marketplace release will restart at
`1.0.0`.

Sections used by every entry, in this order: **Added**, **Changed**, **Deprecated**, **Removed**,
**Fixed**, **Security**. Omit a section when it has no entries.

## [Unreleased]

### Added

- **Guided tour for example workspaces.** After "SqfReloader: Create example mod" the extension
  offers a guided tour; accepting adds a checklist below the status block in the Arma Project view
  and opens it. The seven steps follow the real workflow (project settings → Play Arma 3 → open the
  mission → edit `fn_*.sqf` → see the reload → Debug Console → jump to a definition). Steps the
  extension can observe complete themselves; each links **Read more** to the matching section of
  `ClientMod/README.md`. Progress is stored per workspace, can be reset from the view, and
  **SqfReloader: Start the guided tour** reopens it.
- `scripts/verify-version.js` (`npm run verify:version`) fails when `package.json`,
  `package-lock.json`, `SqfReloaderExtension.csproj`, `BuildStamp.cs` and the `CfgPatches` version
  in `config.cpp` disagree, and `build-all.ps1` now runs it before building.
- `scripts/verify-tutorial.js` covers the tour state machine and the project-settings cache
  headlessly, and `scripts/verify-hemtt-shim.js` covers `.cmd`/`.bat` executable resolution.
  `scripts/verify-links.js` covers the junction logic: replacing a broken junction instead of
  blocking the launch, registering mission links, orphan cleanup and leaving real folders alone.
  `npm run verify` runs all of them with the existing checks.

- The extension offers to create the `$PBOPREFIX$` files HEMTT requires. When
  `sqfReloader.hemtt.enabled` is on and the `hemtt` command resolves, the first check of a project
  with addons that have no `$PBOPREFIX$` asks once per session whether to generate them; the value
  is `<mainprefix>\<prefix>\addons\<addon>` from `.hemtt/project.toml` (or SqfReloader's
  `z\<tag>\addons\<addon>` mount when no prefix is configured). Existing files are untouched. This
  is needed because HEMTT aborts with "Addon prefix not found" and does not generate the file
  itself.
- The example command also creates or extends a workspace `.gitignore` with `**/.hemttout/`, so
  HEMTT's build output for the nested example projects stays out of git. An existing `.gitignore`
  is only appended to, and only when no equivalent `.hemttout` rule is present.
- The generated `ServerMod/` no longer carries its own `.vscode/sqfReloader-settings.json`; the
  launch role for both example mods comes from the workspace-level settings file.
- `ClientMod/` now ships a README with a client walkthrough (Play, Eden Editor, debug console,
  live reload, function navigation, and reopening the mission in Eden). All example `.sqf` files
  use Wiki-style header documentation, which the hover and Ctrl+click navigation display.

### Changed

- **The "example mod is ready" follow-up is a banner in the Arma Project view, not a notification.**
  A notification can only style its first action as a filled button, so **Play Arma 3** and **Start
  dedicated server** now live in the view where both use the theme's button colour (plus a plain
  **Dismiss**). The guided-tour offer stays a separate notification, so the two never replace each
  other.
- **"Create example mod" shows the tour offer and the ready banner together.** The tour offer is no
  longer awaited before the follow-up, and an earlier *Not now* does not hide the tour offer when the
  command is run by hand again.

- **The empty-workspace offer is per workspace.** It used to be recorded in `globalState` keyed by
  the extension version, so the first window that saw it (or merely closed the toast) suppressed the
  offer in every other folder — a fresh empty folder never asked again. The record now lives in
  `workspaceState` (one entry per folder), "Don't ask again" is the only global answer, and
  **SqfReloader: Show the create-example offer again** resets both. The Arma Project view shows the
  same offer as a **No Arma project yet** banner, and no longer asks for project settings in a
  folder that has no project.

- **The empty-workspace prompt leads into the tour.** An empty workspace still asks "This workspace
  has no Arma mod yet. Create an example mod to try live reload?"; after the example is created the
  guided tour is offered next to the ready banner in the Arma Project view.

- **"Stop Arma 3" only closes the instance VS Code started.** The launch PID is remembered and
  terminated with its children; when Arma was started elsewhere (another mod or profile), the
  confirmation dialog says so explicitly before an image-name kill is used. The dedicated server
  stop uses the same PID targeting.
- **The status loop backs off when nothing is running.** Polling stays at 2 s while Arma or its API
  is up and drops to 15 s when everything is down, and the separate 3 s status timer is gone, so an
  idle VS Code window stops spawning `tasklist` and probing the API continuously. The connection
  monitor backoff follows the same rule and wakes immediately after a launch or a command.
- **Project settings are cached.** `.vscode/sqfReloader-settings.json` is parsed once and reused
  until its mtime/size changes (or the settings watcher invalidates it), so `log()`/`logInfo()` no
  longer re-read and re-parse the file for every line.

- **The empty-workspace prompt reads like a user prompt.** "Completed installing extension. This
  workspace has no Arma mod yet. Set up an example mod?" is now "This workspace has no Arma mod
  yet. Create an example mod to try live reload?" with a **Create example mod** button.

- The HEMTT check output channel is quiet: one line with the options in effect when checks start,
  one line naming the projects being checked, and a project's result only when it changes (a first
  clean run is silent, problems are reported once, and a fixed project gets one "is clean again"
  line). Previously every project logged "0 error(s), 0 warning(s)" on every timer tick.

- The example scaffold now writes `ClientMod/` (the `@ExampleMod` mod, its `missions` and
  `mpmissions` test missions) and `ServerMod/` (the server mod, its mission and `server.cfg`)
  instead of dropping the client mod at the workspace root and a `server-example/` folder next to
  it. The workspace project settings give both folders their launch role
  (`ClientMod/@ExampleMod` = client, `ServerMod/@ExampleServerMod` = server).
- Both example mods now ship a `.hemtt/project.toml` and a `$PBOPREFIX$`, so `hemtt check` works
  in `ClientMod/@ExampleMod` and `ServerMod/@ExampleServerMod` with no further setup.
- `README.md` is now the short GitHub landing page; the complete guide moved to `README-FULL.md`.
  Added `AGENTS.md` with instructions for AI agents.
- Large modules were split by responsibility (`projectViewHtml.ts`, `launchArgs.ts`,
  `duplicateFunctions.ts`, `armaDetect.ts`); public exports are unchanged, so the
  `scripts/verify-*.js` entry points keep working.
- Removed the **Shared Mod** launch role. A mod folder is now **Client Mod**, **Server Mod**, or
  **Not Used**; an unclassified folder keeps behaving like a client mod, and an existing `"both"`
  entry in `modTypes` / `externalMods` is read as a client mod instead of being dropped.
- `package.json` categories are now `AI` and `Other`. The previous claims (`Debuggers`, `Linters`,
  `Testing`, `Programming Languages`) did not describe shipped features — see
  [LIMITATIONS.md](./LIMITATIONS.md).
- Added `keywords`, `galleryBanner`, `extensionKind` and `capabilities` for the Marketplace listing.

### Fixed

- **"Create example mod" opens one thing: the `ClientMod/README.md` Markdown preview.** It used to
  open `config.cpp`, `fn_hello.sqf` and the `ServerMod` README as editable tabs; now the rendered
  walkthrough fills the editor area and the other files stay closed until the user opens them.
- **Play Arma 3 no longer aborts when a link already exists.** A junction whose target was deleted
  or moved (`existsSync` reports "missing", `mklink` then fails with "Cannot create a file when that
  file already exists") is now detected through `lstat`, removed and recreated, and the leftover
  mission link is repaired. A real folder at a mount path is still never deleted.
- **A mission that cannot be linked no longer stops the launch.** It is reported as a warning
  ("Arma 3 will start, but the mission folder could not be linked…") and the game starts anyway. The
  dedicated-server equivalent is a warning too.
- **Links created by the extension are removed when VS Code closes, when the extension is disabled
  and when it is uninstalled.** Mission links are now recorded in `.sqfreloader-links.json` (they
  were invisible to cleanup before), so closing VS Code, `SqfReloader: Stop Arma 3` and an Arma exit
  all remove `z\<tag>\addons\<addon>`, `@Mod` (module mode) and `<profile>\Missions\…`. While an Arma
  process is running the links are kept so the live session keeps reading the workspace; they are
  removed when that game exits. Links whose target no longer exists (deleted or moved workspace) are
  pruned on the next launch.
- The example mod's project settings tick the guided tour's **Create the project settings** step, so
  a tour accepted right after **Create example mod** starts at `1/7` instead of `0/7`.
- `package-lock.json` was corrupted by the version bump: the "first version in the file" replace
  rewrote dependency entries, leaving `yauzl` and `@types/vscode` pinned to the project version, so
  `npm ci`/`npm install` failed with `ETARGET`. The bump now rewrites only the manifest's own
  version (`package.json` root and the `""` entry of the lock), and the lock was regenerated.
  `@types/vscode` is pinned to `~1.99.0` (the declared engine) instead of `^1.90.0`.
- HEMTT installed as a `.cmd`/`.bat` shim (scoop, Chocolatey) is executed through `cmd.exe` with
  proper quoting instead of failing with `EINVAL`, which made `hemtt` look missing. A real `.exe`
  on `PATH` still wins.
- A link that exists but cannot be inspected is now logged instead of being reported as "not
  linked" (which hid permission and I/O errors).
- Duplicate API helper removed (`api.evaluateCode` was an exact copy of `api.evalCode`) and the
  unused `runtime.stopStaleArmaProcesses` deleted. Status bars use an explicit `StatusTracker`
  object instead of a module-level timestamp, so two windows no longer share startup-grace state.
- Error messages are always written to the **Arma 3 SQF Reloader** output channel. With
  `logLevel: "error"` the `logError` guard was inverted, so choosing the most restrictive level
  suppressed every error line.
- The extension activates only on Windows. On other platforms it now explains that Arma 3 and a
  local Windows installation are required instead of starting timers, file watchers and HEMTT
  checks that cannot work.
- Stale compiled modules (`out/preLaunch.js`, `out/reloader.js`) are no longer packaged. `out/` is
  rebuilt from scratch before every package, so a deleted source module cannot linger in the
  `.vsix`.
- The staged launch PBO no longer picks up a `$PBOPREFIX$` from the addon source. It is left out
  of the staging copy, so the PBO keeps the addon name as its prefix and cannot collide with the
  `z\<tag>\addons\<addon>` mount that the reloader patches.

### Security

- Declared `capabilities.untrustedWorkspaces.supported: false` and
  `capabilities.virtualWorkspaces.supported: false`. The extension executes SQF in a running game
  and writes into the Arma installation, so it requires a trusted, local workspace.

## [3.8.1] - 2026-11-12

### Added

- HEMTT `check` also covers unsaved edits through a temporary shadow copy, so problems appear
  before a file is saved.

### Changed

- `hemtt check` diagnostics are read from `.hemttout/ci_annotations.txt`, matching what CI reports.

## [3.8.0] - 2026-11-10

### Added

- Arma AI language-model tool (`#armaAiTool`): read live session context and the current RPT,
  check connectivity, and evaluate SQF with confirmation.
- Debug Console webview with watch expressions and live RPT monitoring.

## [3.7.9] - 2026-11-10

### Added

- The Arma AI tool can read the current Arma RPT and reports script errors after an evaluation.

## [3.7.8] - 2026-11-10

### Added

- First version of the Arma AI language-model tool.

## [3.7.5] - 2026-11-10

### Changed

- Project settings, mod launch roles, lifecycle hooks and the project settings panel are stored in
  `.vscode/sqfReloader-settings.json` only; VS Code `settings.json` is never written.

## [3.7.0] - 2026-11-09

### Added

- **Reload and restart mission functions**: terminates mission scripts, reloads CfgFunctions and
  reruns `init.sqf`, `initServer.sqf`, `initPlayerLocal.sqf` and `initPlayerServer.sqf`.

## [3.6.6] - 2026-10-30

### Fixed

- Mission artifacts: Arma-generated `~Mission.World` preview folders are cleaned up.

## [3.6.2] - 2026-10-29

### Added

- Dedicated server support: start `arma3server_x64.exe` with a chosen `server.cfg`, and stop it
  from VS Code.

## [3.6.1] - 2026-10-29

### Added

- **Host Mission** for multiplayer missions (`-host`), including a `maxPlayers > 1` check.

## [3.5.3] - 2026-10-28

### Added

- SQF navigation: definition, hover and reference providers for function names, global variables
  and file-local variables.

## [3.2.6] - 2026-10-26

### Added

- EXAMPLE scaffold with client and server mods, single-player and multiplayer test missions, and a
  dedicated-server configuration.

<!--
============================================================================
Template — copy this block for a new release and fill it in.
============================================================================

## [X.Y.Z] - YYYY-MM-DD

### Added

- What the user can now do that they could not before. Mention the command or setting.

### Changed

- Behavior that changed without a new capability (defaults, wording, output).

### Deprecated

- Still supported, but scheduled for removal and what to use instead.

### Removed

- Features removed, and what replaces them (including how old settings are read).

### Fixed

- User-visible bugs, with the symptom first ("Saving a file with `logLevel: error` printed
  nothing").

### Security

- Anything that changes what the extension can be made to do (API exposure, trust, executed code).

============================================================================
Still missing before the first Marketplace publish (tracked in PLAN.md)
============================================================================

These do not exist yet and must be created or provided outside this file:

- A Marketplace publisher verification for the `VainoKarppi` publisher and a `VSCE_PAT` secret
  used by `vsce publish` / the release workflow.
- Screenshots and one short GIF for the listing; `README-MARKETPLACE.md` currently has none.
  Store them in `media/` and reference them relatively so they travel inside the `.vsix`.
- A support/QnA link and a published privacy statement ("no telemetry; the local API binds to
  127.0.0.1").
- A CI workflow that runs `npm run compile`, the tests and `vsce package` on `windows-latest`
  (nothing runs automatically today).
- A unit-test runner; verification is currently the hand-run `scripts/verify-*.js` scripts.
- Release notes for versions before 3.2.6: reconstructed entries only; add detail if it matters.
-->
