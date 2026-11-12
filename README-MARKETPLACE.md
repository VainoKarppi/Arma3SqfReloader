# Arma 3 SQF Reloader

Edit SQF in VS Code and reload functions in a running Arma 3 session when you save. The extension
starts Arma with your mod, prepares source links for live file patching, and sends changed function
names to the game. The SqfReloader Arma mod and native DLL are bundled with the extension; they do
not need to be installed separately.

For complete documentation, advanced launch and server workflows, settings, hooks, and
troubleshooting, see the [full GitHub README](https://github.com/VainoKarppi/Arma3SqfReloader/blob/main/README-FULL.md).

**Supported platforms, known limitations and out-of-scope features:** [LIMITATIONS.md](./LIMITATIONS.md) ·
**Release notes:** [CHANGELOG.md](./CHANGELOG.md)

## Features

- Reload `fn_*.sqf` functions on save and show Arma compile errors in VS Code.
- Run `hemtt check` periodically and on save — including unsaved edits — and show its errors and
  warnings in the Problems panel.
- Run an SQF file in Arma, with or without parameters.
- Create example mods and missions to try the workflow, with a guided tour that ticks off each
  step (launch, edit, reload, debug console) as you do it.
- Stop only the Arma instance VS Code started; sessions you launched yourself are never closed
  without an explicit warning.
- Launch Arma, host a mission, or start a dedicated server from VS Code.
- Configure project-specific settings, mod launch roles, and lifecycle hooks.
- Create example mods and missions to try the workflow.
- Connect to the local SqfReloader REST API for status, evaluation, and reload operations.

## Requirements

- VS Code 1.99 or later.
- Windows x64 (this extension is supported on Windows x64 only; macOS, Linux, VS Code Web and
  container/WSL hosts are not supported).
- Arma 3 installed, with a trusted (non-restricted-mode) workspace.
- Arma 3 Tools is recommended for building addon PBOs before launch. The extension can continue
  without AddonBuilder if it is unavailable.
- BattlEye sessions are not supported: BattlEye will not load the unsigned SqfReloader extension.

See [LIMITATIONS.md](./LIMITATIONS.md) for the full support matrix — what works, what should work
but is untested, what is planned, and what is deliberately out of scope. Release notes are in
[CHANGELOG.md](./CHANGELOG.md).

## Quick start

1. Install **Arma 3 SQF Reloader** from the Visual Studio Marketplace.
2. Open an empty folder in VS Code.
3. To try it first, run **SqfReloader: Create example mod** from the Command
   Palette.
4. Run **SqfReloader: Play**, then open the Eden Editor or start a mission. Wait for the
   connection status to confirm the game is connected.
5. Edit and save a `fn_*.sqf` function. SqfReloader recompiles it in the running game.
6. In the **Arma debug console** or the extension's **Debug Console** in VS Code, call the
   function to verify the change.

For example, the generated sample function can be called with:

```sqf
[] call example_fnc_hello;
```

When using your own mod, open its folder or a workspace containing it, then run **SqfReloader:
Play**. The extension derives function names from `CfgFunctions` and links source files for
reloading. No `$PBOPREFIX$` file is required.

## Useful commands

Open the **Arma 3** view in the Activity Bar or use the Command Palette:

| Command | Purpose |
| --- | --- |
| **SqfReloader: Play** | Set up the workspace and launch Arma 3. |
| **SqfReloader: Stop Arma 3** | Stop the Arma instance VS Code started and remove extension-created links. |
| **SqfReloader: Start the guided tour** | Reopen the example workspace tour. |
| **SqfReloader: Check connection** | Check the local API and game callback. |
| **SqfReloader: Reload all functions** | Reload workspace functions. |
| **SqfReloader: Reload and restart mission functions** | Reload the active mission's functions and initialization scripts. |
| **SqfReloader: Create example mod** | Generate a sample mod and mission. |
| **SqfReloader: Show output** | View extension logs and Arma script errors. |
| **SqfReloader: Run HEMTT check** | Run `hemtt check` now and refresh problems. |

Right-click an `.sqf` file for **Run in Arma** or **Run in Arma With Parameters**. Right-click a mod
folder to assign its client or server launch role.

## Settings and safety

Project settings are stored in `.vscode/sqfReloader-settings.json`. Use the Arma Project view to
configure reload behavior, launch arguments, API connection settings, mod roles, and hooks. The
extension does not write these values to VS Code's user-level `settings.json`.

If the `hemtt` command is installed, the extension also runs `hemtt check` for every HEMTT project
in the workspace and shows its errors and warnings in the Problems panel. Configure it with
`sqfReloader.hemtt.enabled`, `sqfReloader.hemtt.interval`, `sqfReloader.hemtt.onSave`,
`sqfReloader.hemtt.unsaved`, `sqfReloader.hemtt.lints`, and `sqfReloader.hemtt.executable` in user
or workspace settings. With `sqfReloader.hemtt.unsaved` (the default) unsaved edits are checked
through a temporary shadow copy of the project, so problems appear before you save.

The REST API defaults to `http://127.0.0.1:8764/api`. It can execute SQF in the running game; SQF
execution can change game state. Keep the API on a trusted local interface and do not expose it to
an untrusted network. The API has no request authentication, so any page open in your browser on
the same machine can reach it; see [LIMITATIONS.md](./LIMITATIONS.md) for the current status.

For detailed settings, multiplayer and dedicated-server setup, REST API examples, and
troubleshooting, see the [full documentation on GitHub](https://github.com/VainoKarppi/Arma3SqfReloader/blob/main/README-FULL.md).


## Support

### Issues and suggestions

[Report bugs, request features, or share suggestions on GitHub](https://github.com/VainoKarppi/Arma3SqfReloader/issues).

For bug reports, include steps to reproduce the issue and attach `SqfReloader.log`, found at:
`%LOCALAPPDATA%\SqfReloader\logs\SqfReloader.log`

### Support development

If you find SqfReloader useful, consider supporting its development:

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-support%20my%20work-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=000000)](https://buymeacoffee.com/vainokarppi)
