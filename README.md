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

The example includes `@ExampleMod`, an addon under `addons/scripts` with three example functions
and the reload receiver, plus optional test missions. It also creates `server-example/` with a
dedicated server configuration, server-side mod, and multiplayer mission.

The generated example mod is located at `@ExampleMod/addons/scripts`. The server mod and related
configuration and mission files are generated inside `server-example/`.
The generated test missions in `mpmissions/example.Altis` and `missions/example.Altis` include
their own `init.sqf`, `initServer.sqf`, `initPlayerLocal.sqf`, `initPlayerServer.sqf`, respawn,
and CfgFunctions preInit/postInit examples. The MP mission additionally includes a remote-exec
callback example and working `OnPlayerKilled.sqf` / `OnPlayerRespawn.sqf` scripts configured
through an example respawn template. Its respawn delay and settings are declared in
`description.ext`.

For multiplayer development, open a multiplayer mission's `mission.sqm` and choose **Host
Mission** in the Arma 3 view to launch it with Arma's `-host` option. In a multiplayer session,
saved workspace function changes are compiled on the server and broadcast to connected clients
using `remoteExec`. The active mission must permit
`SqfReloader_fnc_receiveReloadedFunction` in its `CfgRemoteExec` configuration for client
broadcasts. `server-example/` contains the dedicated server example created by the scaffold; the
dedicated server process is separate from SqfReloader's local API.

### Mod launch roles and dedicated server configs

Right-click a mod folder in the Explorer and choose **Arma 3: Set folder as Client Mod**,
**Server Mod**, or **Shared Mod**. The selection is saved in the workspace's `.vscode/settings.json`
under `sqfReloader.modTypes`, keyed by the folder's path relative to the workspace root. A server
mod is left out of normal Arma launches and is passed as `-serverMod` when starting a dedicated
server directly from its workspace folder; it is not copied into the Arma installation. Client,
shared, and unclassified folders use `-mod`; unclassified mods retain the extension's previous
behavior. **Clear Mod Type** removes an explicit assignment.

Every mod folder reaches Arma exactly once: a folder that is both a workspace mod and a configured
external mod (`sqfReloader.externalMods`), which is common when the workspace folder is a copy of
the one in the Arma directory, is listed once in `-mod=` instead of twice, so the game and the
dedicated server no longer load the same PBOs twice.

Mods the extension discovers in the workspace are listed in the project settings panel together
with their launch role, including unclassified ones, so a folder it picked up on its own is always
visible. Set the role to **Not launched** (`"off"` in `sqfReloader.modTypes`) to keep a discovered
folder out of `-mod=`/`-serverMod=` entirely, for example an unpacked server source tree that Arma
itself reports as `GAME DIR (Empty)`.

Workspace missions are junctioned into both the selected profile and the Arma installation's
`Missions` / `MPMissions` folders, so dedicated servers can resolve mission directories without
copying them.

The role is a launch choice, not an automatic analysis of `config.cpp`. Mod folders should
normally contain a root `addons` directory. Missing `mod.cpp` is not an error; if no PBO is found
under `addons`, the folder may still be an unpacked development mod and the extension asks before
assigning it.

Right-click any `.cfg` file and choose **SqfReloader: Start dedicated server**. A real
`hostname = ...` assignment (not a comment or a substring) identifies server configs: the file
picker lists only those, and a single match (for example `server.cfg`) is started right away.
Running the command without a `.cfg` file announces that no server config was found. A `.cfg`
without a `hostname` assignment can only be started by picking that file explicitly, after
confirming the manual override. Before launching, the extension displays the exact command and
asks for confirmation. This starts `arma3server_x64.exe`; a hosted player session remains a
separate `-host` mission action.

Use **SqfReloader: Reload and restart mission functions** from the Command Palette while a
file inside the mission is active and that mission is running in Arma. It terminates running SQF
scripts sourced from that mission folder, reloads its CfgFunctions, and reruns `init.sqf`,
`initServer.sqf`, and `initPlayerLocal.sqf` in the applicable context. In multiplayer, the server
also invokes `initPlayerServer.sqf` for each connected player; the mission must allow
`SqfReloader_fnc_runMissionPlayerServerInit` in `CfgRemoteExec`. `preInit` and `postInit` functions
are recompiled but their bodies are not replayed. `initRespawn.sqf` is not run outside a respawn.
Mod-originated scripts are not terminated or restarted.

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

## Arma Project view

Open the **Arma 3** icon in the Activity Bar for project settings, Host Mission, Debug Console, and
connection status. Use the existing bottom status-bar control to start or stop Arma 3. The
settings action opens a dedicated project settings management tab for launch options, reload
behavior, and workspace or external mod roles. Changes are saved to the workspace's
`.vscode/settings.json`; if that file does not exist, the extension asks before creating it.

The status line reports `Game`, the dedicated server, and the API (last). Each row shows a green dot
when it is up, a blue one while its `.exe` is running but Arma has not connected to the SqfReloader
API yet (`Starting...`), and a red one when it is down, for example
`Game: Running · Dedicated Server: Stopped · API: Running`.
The status-bar control is green when everything that should be connected is connected, shows a
spinner while Arma 3 or the dedicated server is starting or waiting for the game callback, and
turns red only when the API is still missing after that startup period.
When the game (or a dedicated server) connects, the extension writes the endpoint and port to the
**Arma 3 SQF Reloader** output channel, and the mod logs the same port to the RPT:

```text
[SqfReloader] REST API port 8764 (REST API listening on http://127.0.0.1:8764/api/) - the VS Code extension connects to http://127.0.0.1:8764/api/
```

The port comes from `sqfReloader.apiUrl` / `sqfReloader.apiPort` in `settings.json` and is written
to `%LOCALAPPDATA%\SqfReloader\config.json`, which the DLL reads. **Every Arma instance uses that
one port**: the game, the Eden editor, a hosted mission and the dedicated server all bind it, so
there is no separate server port to keep in sync. When the port is taken the DLL falls back to the
next free one and the startup line shows the port actually used.

A status reply never makes the extension claim that a game is running. `Game` and
`Dedicated Server` follow the real `arma3_x64.exe` / `arma3server_x64.exe` process, so a leftover
API from a crashed or closed server is reported as `API ... Connected` with
`Dedicated Server: Stopped`, and the panel keeps showing **Start Dedicated Server**.

The Debug Console opens in an editor tab and includes SQF execution, watch expressions, and latest
RPT controls and output. Live RPT monitoring is enabled by default while the Debug Console tab is
open and can be paused with its checkbox. Execution and watches always go to the Arma instance
that owns the SqfReloader API (the local game); there is no target selector. The API accepts
arbitrary SQF execution; never expose it to an untrusted network.
Watch expressions are refreshed every 1000 ms by default (configurable from 1000 to 60000 ms) and
are evaluated in one SQF batch by `SqfReloader_fnc_evalWatch`.

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

## Call the API from PowerShell

The local REST API can also be called directly, without VS Code. Start Arma with `@SqfReloader`
and wait until its API is listening. By default the address is `http://127.0.0.1:8764/api`; use
the port shown by **SqfReloader: Check connection** or in the Arma `.rpt` if it changed.

Open `http://127.0.0.1:8764/api` in a browser to read the generated API documentation: version,
live Arma callback state, every endpoint with its body and result, and ready-to-copy
`curl`/PowerShell examples. Requests without an HTML `Accept` header still get the status JSON, so
existing scripts are unaffected.

Query the running extension and the functions it can reload:

```powershell
$api = "http://127.0.0.1:8764/api"
Invoke-RestMethod "$api/status"
Invoke-RestMethod "$api/functions"
```

Send SQF for execution in the current game/editor context:

```powershell
$api = "http://127.0.0.1:8764/api"
$body = @{ code = 'systemChat "Hello from PowerShell";' } | ConvertTo-Json
Invoke-RestMethod "$api/eval" -Method Post -ContentType "application/json" -Body $body
```

`POST /api/execute` is fire-and-forget: it returns as soon as Arma accepts the SQF. Use
`POST /api/eval` when you need the SQF return value. It waits up to `timeoutMs` (default 30
seconds, capped at 300 seconds) and returns the value in the same HTTP response:

```powershell
$body = @{ code = '1 + 1'; timeoutMs = 30000 } | ConvertTo-Json
Invoke-RestMethod "$api/eval" -Method Post -ContentType "application/json" -Body $body
```

The PowerShell helper does the same and enforces its timeout:

```powershell
.\examples\Invoke-ArmaSqf.ps1 -Code '1 + 1' -TimeoutSeconds 30
```

The script returns `2`. Set `sqfReloader.runTimeout` to change the default timeout used by the
right-click **Run in Arma** commands. The scripts in [`examples`](examples) also show status
and function queries, reloading functions, and sending a registered event.

`/api/eval` returns the value twice: `text` is the exact SQF `str` rendering
(`[[B Alpha 1-1:1,B Alpha 1-1:2],[],[-999]]`, no extra quoting), and `result` is that literal
parsed into arrays, strings, numbers and booleans. On timeout it responds with HTTP 408; SQF
already running in Arma is not forcibly stopped. For fire-and-forget scripts, call
`/api/execute` instead:

```powershell
$body = @{ code = 'systemChat "Queued from PowerShell";' } | ConvertTo-Json
Invoke-RestMethod "$api/execute" -Method Post -ContentType "application/json" -Body $body
```

The API also supports `POST /api/reload` with `{"functions":["TAG_fnc_name"]}` to reload named
functions, or `{}` to request a full reload. `POST /api/send` accepts
`{"function":"EventName","data":[...]}` and invokes an event handler registered in SQF with
`["EventName"] call SqfReloader_fnc_send;`.

Requests are queued for the game thread. `/api/execute` and the other queue endpoints return
when Arma accepts the request; `/api/eval` waits for the execution result or an error, up to its
server-side timeout.

## Settings

| Setting | Purpose |
| --- | --- |
| `sqfReloader.armaDirectory` | Arma 3 install folder. Leave empty for automatic detection: the folder is read once from the registry / Steam libraries when the extension loads and kept in memory for the session, so nothing is written back to this setting. Set it only to pin a specific install. |
| `sqfReloader.enabled` | Enable or disable reload on save. |
| `sqfReloader.apiUrl` | SqfReloader API host address. The extension adds the API path and uses `sqfReloader.apiPort`. Default: `http://127.0.0.1`. |
| `sqfReloader.apiPort` | SqfReloader API port, used by every Arma instance (client, editor, hosted mission, dedicated server). Default: `8764`. |
| `sqfReloader.runTimeout` | Maximum seconds for **Run in Arma** to wait for a result. Default: `30`. |
| `sqfReloader.logLevel` | Output verbosity: `error`, `warning`, `info` (default), or `verbose`. Verbose includes Arma function registration diagnostics; change it live in `settings.json`. |
| `sqfReloader.extraLaunchArguments` | Extra Arma launch options. |
| `sqfReloader.junctionMode` | Link per addon (`addon`) or per mod (`module`). |

## Troubleshooting

**The extension cannot find Arma.** Set `sqfReloader.armaDirectory` to the folder containing
`arma3_x64.exe`. Leave it empty to keep the automatic detection (registry / Steam libraries).

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
