# AGENTS.md

Instructions for AI agents working in this repository. Keep it short; the code is the source of
truth.

## What this is

A VS Code extension (`src/*.ts`) that hot-reloads SQF functions in a running Arma 3 game, plus a
native C# (NativeAOT) extension under `SqfReloaderExtension/` that serves the local REST API, and
editable example projects under `examples/armaExamples/`. Windows only.

## Workflow: Read → Plan → Write → Test

1. **Read first.** Do not guess. Read the files you will touch and their neighbours:
   - `src/extension.ts` — activation, all commands, save→reload handler, status bar.
   - `src/settings.ts` — settings model; `src/projectSettings.ts` — `.vscode/sqfReloader-settings.json`.
   - `src/arma.ts` + `src/armaDetect.ts` — mod/mission/CfgFunctions discovery, Arma install lookup.
   - `src/launcher.ts` + `src/launchArgs.ts` — processes, RPT monitor, Steam, command line.
   - `src/dllIntegrity.ts` — Smart App Control / code-integrity blocks on the bundled DLL
     (loader status `0xC0E90002`, Arma's "Bad Image" dialog), checked before a launch.
   - `src/reload.ts` — compile/reload, snapshots, mission restart.
   - `src/junctions.ts`, `src/runtime.ts`, `src/pbo.ts` — linking, `@SqfReloader` deployment, PBO staging.
   - `src/status.ts` — status bar state machine; `src/diagnostics.ts` — the support report written
     by "SqfReloader: Create diagnostic report" (redacts personal data before writing).
   - `src/projectView.ts` + `src/projectViewHtml.ts` — the Arma Project panel and its webviews.
   - `src/tutorial.ts` — guided tour steps, progress (`workspaceState`) and README deep links.
   - `src/workspaceHelpers.ts` — workspace/mod/mission queries; `src/missionRecompile.ts` — enabling
     `allowFunctionsRecompile`; `src/duplicateFunctions.ts` — duplicate-function diagnostics.
   - `src/hemtt.ts` — `hemtt check` integration; `src/addonPrefixes.ts` — missing `$PBOPREFIX$`
  detection/generation; `src/links.ts` — SQF navigation providers.
   - `examples/armaExamples/` — templates copied by "Create example mod".
   - `SqfReloaderExtension/src/Plugin/` — the native API (routes, config, JSON).
   - `PLAN.md`, `LIMITATIONS.md`, `CHANGELOG.md` — what is planned, supported, and shipped.
2. **Plan.** Write down the files to change, the behavior that must stay identical, and how you
   will verify it. Prefer the smallest set of files that fully solves the problem.
3. **Write in one pass.** Make the complete set of edits together (related files in one batch),
   then move on. Do not interleave half-edits with test runs.
4. **Test.** Run the checks in "Verification" below, fix what fails, and only then report done.

## Hard rules

- **Never write to VS Code's `.vscode/settings.json`.** Project settings live in
  `.vscode/sqfReloader-settings.json` only.
- **Never create or change a `$PBOPREFIX$` that already exists.** The one exception is the
  user-confirmed HEMTT flow: when `sqfReloader.hemtt.enabled` is on and `hemtt` resolves, the check
  offers once per project per session to write missing `$PBOPREFIX$` files, derived from
  `.hemtt/project.toml` (`<mainprefix>\<prefix>\addons\<addon>`) or SqfReloader's mount
  (`z\<tag>\addons\<addon>`). See `src/addonPrefixes.ts`.
- **The staged launch PBO never inherits `$PBOPREFIX$`** (`src/pbo.ts` skips it) so the PBO prefix
  stays the addon name and cannot collide with the z-mount.
- **Keep mod roles to `client` / `server` / `off`.** A legacy `"both"` in settings is read as
  `client`; do not add new roles or a Shared Mod command.
- **Keep public module exports stable** when splitting files. `scripts/verify-*.js` require
  `out/arma.js`, `out/reload.js`, `out/launcher.js`, `out/runtime.js`, `out/junctions.js`,
  `out/settings.js` and `out/scaffold.js` by name — re-export from the old module if you move code.
- **No new runtime dependencies.** The extension must work offline; use Node built-ins.
- **Never commit** `out/`, `vscode-runtime/`, `*.vsix`, secrets, or `%LOCALAPPDATA%` artifacts.
- **Windows-only assumptions are intentional.** Guard platform-specific code with
  `process.platform === "win32"` and never start timers before the activation guard.
- Match existing style: 4 spaces, double quotes, `async`/`await`, explicit return types on exports.
  Comment only what is not obvious (why, not what).

## Verification

```powershell
npm run clean ; npm run compile          # must be error-free
npm run verify                           # version gate + links + tour/cache + HEMTT shim + scaffold + tags
node scripts/verify-links.js             # junctions: broken-link repair, mission registration, cleanup
node scripts/verify-tutorial.js          # guided tour state machine + project-settings cache
node scripts/verify-hemtt-shim.js        # .cmd/.bat executable resolution
node scripts/verify-excluded-folders.js  # excludedFolders: discovery, duplicate check, missions
node scripts/verify-duplicate-diagnostics.js  # stale duplicate-function markers clear themselves
node scripts/verify-detached-launch.js    # Arma survives a window reload; API port adoption
node scripts/verify-rename.js            # F2 rename: globals across files, locals per scope
node scripts/verify-diagnostics.js       # diagnostic report redaction + one real collection run
node scripts/verify-dll-integrity.js     # Smart App Control / Bad Image preflight (0xC0E90002)
npx --no-install @vscode/vsce ls         # packaged file list: no orphans, no dev files
hemtt check                              # inside a generated ClientMod/@ExampleMod or ServerMod/@ExampleServerMod
```

`build-all.ps1` uses a signing certificate by default: `-SignThumbprint` / `-SignPfx` /
`-SignMetadata`, else the `SQFRELOADER_SIGN_*` environment variables, else the newest code-signing
certificate in the current user's store — and it **stops before building** when there is none.
After the native build it always runs `checkSignature.ps1` on
`dist\@SqfReloader\SqfReloader_x64.dll` and fails unless the signature is valid, so an unsigned DLL
can never be packaged. `-NoSignature` builds unsigned and only prints the check.

`SqfReloaderExtension\tools\checkSignature.ps1 <dll|folder>` reports what Windows, Smart App
Control and BattlEye look at: status (`Valid` / `NotSigned` / untrusted chain), signer and issuer,
chain root (with a warning for a self-signed certificate), RFC 3161 timestamp and the
Mark-of-the-Web. Exit code 0 only when every checked file verifies.

[TESTING.md](./TESTING.md) is the manual checklist (tour, stop-own-instance, idle polling, HEMTT
shim) for anything that needs a real game.

`scripts/verify-extension.js` and `scripts/verify-launch-args.js` need a real Arma install and a
mod folder; run them only when asked. `SqfReloaderExtension/tools/test-extension.ps1` drives the
native `callExtension` harness and requires the .NET SDK and Arma 3 Tools.

## Cheap sanity checks

- Small harnesses with `scripts/vscode-stub.js` can load `out/*.js` in plain Node: stub `vscode`,
  set `vscode.workspace.workspaceFolders`, then call the exported function. Use this instead of
  asking the user to test.
- `ARMA_API_TEST_OUTPUT=<file>` mirrors extension logs (and drives the scaffold/Play test hooks).
- When packaging matters, run `npx --no-install @vscode/vsce package --readme-path README-MARKETPLACE.md -o build-check.vsix`
  and delete the file afterwards.

## Documentation duties

- User-facing behavior change → update `README-FULL.md` (full guide) and, if it is a feature
  highlight, `README-MARKETPLACE.md` and the short `README.md`.
- Supported/unsupported behavior → update `LIMITATIONS.md`.
- Released change → add an entry under `Unreleased` in `CHANGELOG.md` (sections: Added, Changed,
  Deprecated, Removed, Fixed, Security).
- Planned work → `PLAN.md` (keep item IDs stable and mark items `DONE` rather than deleting them).
