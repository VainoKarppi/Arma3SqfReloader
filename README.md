# Arma 3 SQF Reloader

Edit SQF in VS Code and reload it in a running Arma 3 session when you save. The extension
starts Arma with your mod and SqfReloader, links your addon files for file patching, and sends
changed function names to the game.

## How it works

```text
  VS CODE                                             ARMA 3
┌──────────────────┐                      ┌──────────────────────────────┐
│ Play             │ ── launch game ─────▶│ Arma 3 + your mod +          │
└──────────────────┘                      │ @SqfReloader                 │
                                          └──────────────┬───────────────┘
                                                         │ API starts and
                                                         │ game callback connects
                                                         ▼
┌──────────────────┐   POST function     ┌──────────────────────────────┐
│ Save fn_name.sqf │ ── name on save ───▶│ SqfReloader local API         │
└──────────────────┘                    └──────────────┬───────────────┘
         ▲                                              │
         │                                              ▼
         │                                  ┌──────────────────────────────┐
         │                                  │ Compile from z\tag\addons\  │
         │                                  │ addon\functions\fn_name.sqf │
         │                                  └──────────────┬───────────────┘
         │                                                 │
         │                                                 ▼
         │                                  ┌──────────────────────────────┐
         └──── next call uses new code ────│ missionNamespace             │
                                            │ TAG_fnc_name                 │
                                            └──────────────────────────────┘

  At startup, workspace functions are injected when the game callback is ready.
```

## Install

Install the `.vsix` from VS Code, or run:

```powershell
code --install-extension .\arma3-sqf-reloader-<version>.vsix
```

The extension includes the SqfReloader Arma mod and native DLL. You do not need to install
those separately.

## Try the example

1. Open an empty folder in VS Code.
2. Run **SqfReloader: Create example mod (try the reloader)** from the Command Palette.
3. Run **SqfReloader: Play** and wait for the extension to connect.
4. Edit and save `fn_hello.sqf`.
5. In Arma’s debug console, run `[] call example_fnc_hello;` to check the updated function.

The example includes `@ExampleMod`, an addon with three functions, and an optional test mission.

## Use your own mod

Open the mod folder or a workspace containing it. No `$PBOPREFIX$` file is required, and the
extension never creates or changes one. It derives function names from `CfgFunctions` and mounts
the source addon under its own `z\<tag>\addons\<addon>` path for live reloads. Your existing
prefix remains available for normal PBO builds and loading the mod manually. Run
**SqfReloader: Play** to set up links and start Arma with your mod.

On launch, the extension keeps checking for SqfReloader. When the game callback is ready, it
injects workspace `fn_*.sqf` functions into `missionNamespace`. You can open Eden later; the
initial injection does not depend on opening it within a fixed time.

When you save a `fn_*.sqf` file, the extension sends its function name to Arma. SqfReloader
compiles the source through the addon’s `z\<tag>\addons\<addon>` link and updates the
function in `missionNamespace`. Compile errors from the Arma `.rpt` appear in the SqfReloader
output and as VS Code diagnostics.

Right-click an `.sqf` file and choose **Run in Arma** to execute it with no arguments, or
**Run in Arma With Parameters** to enter an SQF array such as `[1, 1]`. The returned value is
shown in the **Arma 3 SQF Reloader** output channel.

## Commands

| Command | Action |
| --- | --- |
| **SqfReloader: Play** | Set up the workspace links and start Arma. |
| **SqfReloader: Stop Arma 3** | Close Arma and remove this extension’s mod links. |
| **SqfReloader: Check connection** | Check the API and game callback. |
| **SqfReloader: Reload current function** | Reload the active SQF function. |
| **SqfReloader: Reload all functions** | Reload workspace functions. |
| **SqfReloader: Toggle reload on save** | Turn automatic reload on or off. |
| **SqfReloader: Show output** | Open extension logs and Arma error messages. |

Other commands set up mods, remove extension-created links, open the Arma folder, and create the
example project.

## Settings

| Setting | Purpose |
| --- | --- |
| `sqfReloader.armaDirectory` | Arma 3 install folder. Leave empty for automatic detection. |
| `sqfReloader.enabled` | Enable or disable reload on save. |
| `sqfReloader.apiUrl` | SqfReloader API address. Default: `http://127.0.0.1:8764/api`. |
| `sqfReloader.extraLaunchArguments` | Extra Arma launch options. |
| `sqfReloader.junctionMode` | Link per addon (`addon`) or per mod (`module`). |

## Troubleshooting

**The extension cannot find Arma.** Set `sqfReloader.armaDirectory` to the folder containing
`arma3_x64.exe`.

**The game is running but the extension is waiting.** Open a mission in Eden once. SqfReloader
starts its API when the editor initializes; the extension will inject the initial functions
after the game callback connects.

**A function is undefined.** Confirm the mod is enabled in Arma and check **SqfReloader: Show
output** for connection or compile errors.

**The saved code does not take effect.** Check the Arma `.rpt` and the SqfReloader output. The
addon link must point to the workspace source under `<Arma 3>\z\<tag>\addons\<addon>`.

## Build from source

Requirements: .NET SDK 10, Visual Studio 2022 Build Tools with C++ tools, Node.js 20+, VS Code,
and Arma 3 Tools AddonBuilder.

```powershell
powershell -ExecutionPolicy Bypass -File build-all.ps1
```

The build creates the native extension, packages the SqfReloader Arma mod, compiles the VS Code
extension, and produces a `.vsix`. Add `-Install` to install the VS Code extension after the
build. See `build-all.ps1` for additional options.
