# Arma 3 SQF Reloader

Live SQF development for Arma 3 in VS Code: edit a function, save, and it is recompiled in the
running game. Launch Arma with your mod, host a mission or start a dedicated server from the
editor, and see Arma's script errors in the Problems panel.

The SqfReloader Arma mod and its native DLL ship inside the extension — there is nothing to
install in Arma.

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-support%20my%20work-FFDD00?style=flat&logo=buy-me-a-coffee&logoColor=000000)](https://buymeacoffee.com/vainokarppi)

## Features

- **Live SQF reload** — edit and save your mission's or mod's `.sqf` script and the function gets
  automatically recompiled in the game; compile errors from the Arma RPT appear as VS Code
  diagnostics.
- **Launch and servers** — Play with your mod, open a mission in Eden, host it (`-host`), or start
  and stop a dedicated server with a chosen `server.cfg`.
- **Run SQF** — right-click a file to run it in Arma, with or without parameters, and read the
  returned value.
- **Mission restart** — reload the active mission's CfgFunctions and rerun its `init` scripts.
- **Project tooling** — mod launch roles, external/Workshop mods, mission linking, PBO staging,
  lifecycle hooks, and a project settings panel stored in `.vscode/sqfReloader-settings.json`.
- **Guided tour** — a step-by-step checklist in the Arma Project view (launch → edit → reload →
  debug console) for workspaces created by the example command; steps tick themselves as you do
  them.
- **HEMTT** — `hemtt check` on a timer and on save, including unsaved edits, with results in the
  Problems panel. If HEMTT is enabled and installed, the extension also offers to generate the
  `$PBOPREFIX$` files HEMTT needs when they are missing.
- **SQF navigation** — Ctrl+click, hover documentation and references for functions and variables.
- **AI tool** — `#armaAiTool` reads live Arma context and RPT errors and can evaluate SQF.
- **Local REST API** — drive a running game from PowerShell or any local tool.

## Requirements

- Windows (x64). Not supported on macOS, Linux, VS Code Web or container/WSL hosts.
- VS Code 1.99 or later, in a trusted workspace.
- Arma 3 installed; Arma 3 Tools recommended for staging addon PBOs.

See [LIMITATIONS.md](./LIMITATIONS.md) for the full support matrix: what works, what *should*
work but is untested, what is planned, and what is deliberately out of scope.

## Quick start

1. Install the extension, then open an empty folder.
2. Run **SqfReloader: Create example mod** — it writes `ClientMod/` (client mod, missions,
   HEMTT project) and `ServerMod/` (server mod, `server.cfg`), then offers a guided tour.
3. Run **SqfReloader: Play** and open a mission or the Eden Editor.
4. Edit and save `ClientMod/@ExampleMod/addons/scripts/functions/fn_hello.sqf`, then call
   `[] call example_fnc_hello;` in the debug console.

Using your own mod: open its folder and run **SqfReloader: Play**. No `$PBOPREFIX$` is required
unless you use HEMTT, in which case the extension offers to generate the missing ones — see
**Features** above.

## Documentation

| Document | Contents |
| --- | --- |
| [README-FULL.md](./README-FULL.md) | Complete guide: how it works, launch and server workflows, settings reference, hooks, API, troubleshooting, building from source. |
| [LIMITATIONS.md](./LIMITATIONS.md) | Support matrix and known limitations. |
| [TESTING.md](./TESTING.md) | What to test in an unreleased build, and how. |
| [CHANGELOG.md](./CHANGELOG.md) | Release notes. |
| [PLAN.md](./PLAN.md) | Release plan and future backlog. |
| [examples/](./examples) | PowerShell scripts for the REST API and the example mod templates. |

## Security

The local REST API can execute arbitrary SQF in a running game and has no request
authentication. Keep it on `127.0.0.1` and never expose it to a network; see
[LIMITATIONS.md](./LIMITATIONS.md).

## Support

Report bugs and request features on [GitHub](https://github.com/VainoKarppi/Arma3SqfReloader/issues).
For bug reports, attach `SqfReloader.log` from `%LOCALAPPDATA%\SqfReloader\logs\SqfReloader.log`
and the Arma `.rpt`.

## License

[MIT](./LICENSE.md)
