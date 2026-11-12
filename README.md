# Arma 3 SQF Reloader

Edit SQF in VS Code and reload it in a running Arma 3 session when you save. The extension
starts Arma with your mod and SqfReloader, links your addon files for file patching, and sends
changed function names to the game.

### Support development
If you find SqfReloader useful, consider supporting its development:

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-support%20my%20work-FFDD00?style=flat&logo=buy-me-a-coffee&logoColor=000000)](https://buymeacoffee.com/vainokarppi)

## How it works

```text
  VS CODE                                             ARMA 3
┌──────────────────┐                     ┌──────────────────────────────┐
│ Play             │ ── launch game ────>│ Arma 3 + dev mod(s) +        │
└──────────────────┘                     │ @SqfReloader                 │
                                         └──────────────┬───────────────┘
                                                        │ API starts and
                                                        │ game callback connects
                                                        ▼
┌──────────────────┐   POST function     ┌──────────────────────────────┐
│ Save fn_name.sqf │ ── name on save ──> │ SqfReloader local API        │
└──────────────────┘                     └──────────────┬───────────────┘
         ▲                                              │
         │                                              ▼
         │                                ┌──────────────────────────────┐
         │                                │ Compile from z\tag\addons\   │
         │                                │ addon\functions\fn_name.sqf  │
         │                                └──────────────┬───────────────┘
         │                                               │
         │                                               ▼
         │                                ┌──────────────────────────────┐
         └─── next call uses new code ─── │ missionNamespace             │
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
and optional test missions. It also creates `server-example/` with a dedicated server
configuration, server-side mod, and multiplayer mission. The editable client and server templates
used by the command are in `examples/armaExamples/client-example` and
`examples/armaExamples/server-example`.

The example mod is located at `@ExampleMod/addons/scripts`; its editable source is in
`examples/armaExamples/client-example/@ExampleMod`. The server mod and related configuration and
mission files are copied to `server-example/`. Editable single-player and multiplayer test
missions are in `examples/armaExamples/client-example/missions/example.Altis` and
`examples/armaExamples/client-example/mpmissions/example.Altis`, and the default project settings
are in `examples/armaExamples/client-example/.vscode/sqfReloader-settings.json`. The copied test
missions include
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
**Server Mod**, or **Shared Mod**. The selection is saved in the workspace's
`.vscode/sqfReloader-settings.json` under `modTypes`, keyed by the folder's path relative to the
workspace root. A server
mod is left out of normal Arma launches and is passed as `-serverMod` when starting a dedicated
server directly from its workspace folder; it is not copied into the Arma installation. Client,
shared, and unclassified folders use `-mod`; unclassified mods retain the extension's previous
behavior. **Clear Mod Type** removes an explicit assignment.

Every mod folder reaches Arma exactly once: a folder that is both a workspace mod and a configured
external mod (`externalMods`), which is common when the workspace folder is a copy of
the one in the Arma directory, is listed once in `-mod=` instead of twice, so the game and the
dedicated server no longer load the same PBOs twice.

Mods the extension discovers in the workspace are listed in the project settings panel with their
launch role, so a folder it picked up on its own is always visible. Creating the project settings
writes every discovered mod as **Not Used** (`"off"` in `modTypes`), so a new project
never launches a folder that was not opted into. The panel offers **Client Mod**, **Server Mod**,
and **Not Used**; a folder marked **Shared Mod** (or left unclassified) in the Explorer behaves
like a client mod and is shown as Client Mod there. External local or Steam Workshop mods can also
be set to **Not Used**, which keeps them configured but excludes them from `-mod=` and
`-serverMod=`. **Remove** in the workspace-mod list sets a mod back to Not Used, which keeps it out
of those launch lists entirely, for example an unpacked server source tree that Arma itself reports
as `GAME DIR (Empty)`.

Workspace missions are junctioned into both the selected profile and the Arma installation's
`Missions` / `MPMissions` folders, so dedicated servers can resolve mission directories without
copying them.

Before each client or dedicated-server launch, the extension uses Arma 3 Tools AddonBuilder to
create a PBO beside every addon folder under the active mods' `addons` directories. The staged PBO
omits `.sqf` files and removes `CfgFunctions` declarations from `.cpp` / `.hpp` files, while
preserving the original source files for live reloading and other config declarations. If
AddonBuilder is not found in the Arma 3 Tools registry, the extension explains that Arma 3 Tools
must be installed and launched once, and lets you continue without creating PBOs or cancel launch.
Registry discovery checks the Steam App 233800 uninstall entry. If needed, set the VS Code
user-level `sqfReloader.arma3ToolsDirectory` setting to the Arma 3 Tools installation directory
(or directly to `AddonBuilder.exe`); when set, this path is validated and takes precedence over
registry discovery.

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
behavior, and workspace or external mod roles. Changes are saved to the project's own
`.vscode/sqfReloader-settings.json`; if that file does not exist, the extension asks before
creating it. The extension never reads or writes `.vscode/settings.json`, and a file that already
exists only gets the missing settings added, so existing values are kept.

The **Arma AI** language-model tool can check connectivity, inspect the live Arma context (mode,
mission, server/client role, loaded mods, activated addons, and SqfReloader log-file path), read
the current Arma `.rpt`, or run an SQF expression and return its result. After each evaluation, it
checks the `.rpt` for script errors because an accepted API response does not guarantee that the
SQF ran without errors. Evaluation requires user confirmation because SQF can change live game
state. For manual evaluation, use the existing **Debug Console**.

The panel also configures **hooks**: commands that run in a VS Code terminal at lifecycle
events, for example `"${workspaceFolder}\\Tools\\BuildExtension.ps1"` before a client or server
launch. A blocking hook waits for its commands and, unless `continueOnError` is set, a non-zero
exit code cancels the action. The default terminal presentation (`echo`, `reveal`, `focus`,
`panel`) is stored in `hookPresentation`; each hook can override it.

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
[SqfReloader] REST API port 8764 (REST API listening on http://127.0.0.1:8764/api/)
```

The port comes from `apiUrl` / `apiPort` in `.vscode/sqfReloader-settings.json` and is written
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
are evaluated in one SQF batch by `SqfReloader_fnc_evalWatch`. Up to 10 expressions can be watched
at a time.

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
| **SqfReloader: See references** | Right-click a function `.sqf` file in the Explorer (or anywhere in its editor) to list every place it is called from. Shift+F12 / Shift+Alt+F12 also work: on a `TAG_fnc_name` they list that function's call sites, and inside a `fn_*.sqf` file they list the file's own.

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

The script returns `2`. Set `runTimeout` to change the default timeout used by the
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

Project settings live in the workspace's `.vscode/sqfReloader-settings.json`. Keys missing from
that file use the built-in defaults below. The file is validated against a JSON schema, so the
editor completes and documents its keys. Three user-level options are read from VS Code's
`settings.json` instead: `sqfReloader.arma3ToolsDirectory` (see above),
`sqfReloader.functionLinks`, `sqfReloader.globalVariableLinks` and
`sqfReloader.localVariableLinks` (all default `true`). Nothing is written to `settings.json`.
`sqfReloader.localVariableLinks` is scoped to `resource`, so it can also be set per workspace
folder.

### HEMTT checks

When the `hemtt` command is installed, the extension runs `hemtt check` for every HEMTT project in
the workspace — any folder containing `.hemtt/project.toml`, including nested ones — and publishes
the results to the Problems panel as errors and warnings on the reported file, line and column. The
diagnostics are read from `.hemttout/ci_annotations.txt`, the file HEMTT writes for GitHub Actions,
so the editor shows exactly what CI would. These options are read from VS Code's `settings.json`,
so they can be set for the user or for the workspace:

| Setting | Default | Description |
| --- | --- | --- |
| `sqfReloader.hemtt.enabled` | `true` | Run `hemtt check` in the background. |
| `sqfReloader.hemtt.interval` | `30` | Seconds between automatic runs. |
| `sqfReloader.hemtt.onSave` | `true` | Re-run the check for the project that contains a saved `.sqf`, `.cpp`, `.hpp`, `.cfg`, `.sqm` or `.toml` file. |
| `sqfReloader.hemtt.unsaved` | `true` | Also check unsaved edits (see below). |
| `sqfReloader.hemtt.lints` | `[]` | Extra lints, each passed as `-L <lint>` (e.g. `s01-invalid-command`). |
| `sqfReloader.hemtt.executable` | `""` | Path to `hemtt`/`hemtt.exe` when it is not on `PATH`. |

**SqfReloader: Run HEMTT check** runs it immediately.

`hemtt check` only reads files from disk, so unsaved edits are checked through a **shadow copy** of
the project: the unsaved buffers are written into a temporary folder in the extension's global
storage, next to junctions to the real folders (only the folders along an edited file are copied),
and HEMTT runs there. Problems are still reported against the real files, so a fix in the editor
clears the diagnostic before the file is saved. The project's own files, including `.hemttout`, are
never written to. Set `sqfReloader.hemtt.unsaved` to `false` to check only what is on disk.

A HEMTT project that stops before reporting diagnostics — a malformed `project.toml`, a missing
`$PBOPREFIX$`, an addon prefix mismatch — has nothing to annotate, so the reason is written to the
SqfReloader output channel instead.

`sqfReloader.functionLinks` resolves `TAG_fnc_name` in `.sqf` files: Ctrl+click opens the matching
`fn_name.sqf`, and hovering shows the function's header documentation (description, parameters,
returns) or, when the file has no header, its `params` as a small aligned SQF block listing Name,
Default and Type (e.g. `_target  [0, 0, 0]  ARRAY or OBJECT`), or its `_this select` / `_this #`
interface. Only top-level statements count, so a `params` inside a `{ ... }` block (an event
handler, for example) is ignored.

`sqfReloader.globalVariableLinks` resolves global variables, i.e. any tagged name that is not a `fnc`
function (`EOEX_var_test`, `EOEX_test2`, ...). A definition is an assignment (`EOEX_var_test =
true;`) or `missionNamespace setVariable ["EOEX_var_test", value]`. Ctrl+click on a usage
(`if (EOEX_var_test)`, `getVariable "EOEX_var_test"`, `getVariable ["EOEX_var_test", true]`,
`isNil "EOEX_var_test"`) jumps to the definition; when a variable is defined in several places,
Ctrl+click lists them all with the defining line so you can pick one. Comments and strings never
count as definitions. Only the mission namespace is tracked — `uiNamespace`/`profileNamespace`
variables are not resolved.

`sqfReloader.localVariableLinks` resolves file-local names (`private _test = ...`, `_test2 = ...`)
and `params` entries (`params ["_myValue"]`) inside the file you have open. Only that one document is scanned, on
demand and cached per document version, so an unsaved edit is picked up immediately and nothing is
indexed from files you have not opened. Because locals are never resolved across files, a value
passed with `[_data] call ANOTHER_FILE` is not resolvable inside `ANOTHER_FILE`.

Local resolution follows SQF scope rules: every `{ ... }` block is its own scope, so a
`private _clientId = _x;` inside one `forEach` block is not a definition for a same-named variable
in a sibling block. The nearest enclosing scope that declares the name wins (shadowing), and only
declarations above the usage count, because SQF runs top to bottom. Recognized declarations are
`private _x = ...`, plain `_x = ...`, `private ["_a", "_b"];`, `private "_c";`,
`private _one = param [0, 1];`, and `params [...];` (which is scoped to its own block).
Automatic reload on save only runs for supported source files inside a VS Code workspace root that
contains `.vscode/sqfReloader-settings.json`. Saves outside that configured project are ignored and
do not send commands or reload requests to Arma. Use the explicit SqfReloader reload commands when
you want to send changes manually.
If multiple `fn_*.sqf` files resolve to the same Arma function variable, SqfReloader marks each
definition as an error and blocks reloads until the duplicate is renamed or removed.

| Setting | Purpose |
| --- | --- |
| `armaDirectory` | Arma 3 install folder. Leave empty for automatic detection: the folder is read once from the registry / Steam libraries when the extension loads and kept in memory for the session, so nothing is written back to this setting. Set it only to pin a specific install. |
| `enabled` | Enable or disable automatic reload for supported files in a configured project. |
| `deletedFunctionBehavior` | When a `fn_*.sqf` file is deleted, `clear` removes its missionNamespace variable from running Arma, `ask` prompts before removing it, and `keep` leaves the variable intact (default). |
| `apiUrl` | SqfReloader API host address. The extension adds the API path and uses `apiPort`. Default: `http://127.0.0.1`. |
| `apiPort` | SqfReloader API port, used by every Arma instance (client, editor, hosted mission, dedicated server). Default: `8764`. |
| `runTimeout` | Maximum seconds for **Run in Arma** to wait for a result. Default: `30`. |
| `logLevel` | Output verbosity: `error`, `warning`, `info` (default), or `verbose`. Verbose includes Arma function registration diagnostics; change it live in the project settings file. |
| `extraLaunchArguments` | Extra Arma launch options. |
| `junctionMode` | Link per addon (`addon`) or per mod (`module`). |
| `hooks` | Commands run in a VS Code terminal at lifecycle events, keyed by event name (`preClientLaunch`, `postReload`, `onServerCrash`, ...). Each hook has `commands`, `blocking`, `continueOnError`, and an optional `presentation` override. |
| `hookPresentation` | Default presentation of every hook terminal: `echo`, `reveal` (`always`, `silent`, `never`), `focus`, and `panel` (`shared`, `dedicated`, `new`). Defaults: `{ "echo": true, "reveal": "always", "focus": false, "panel": "shared" }`. |

Commands can use `${workspaceFolder}`, `${workspaceFolderBasename}`, `${armaDirectory}`,
`${missionFolder}`, `${file}`, `${apiUrl}`, `${exitCode}`, and `${event}`. The same values are
exposed as `SQFRELOADER_EVENT`, `SQFRELOADER_WORKSPACE`, `SQFRELOADER_ARMA_DIR`,
`SQFRELOADER_MISSION`, `SQFRELOADER_FILE`, `SQFRELOADER_API_URL`, and `SQFRELOADER_EXIT_CODE`.

### Lifecycle hooks

Events marked blocking wait for their commands; a failing blocking command cancels the action
unless `continueOnError` is enabled. All other events run in the background.

| Event | When |
| --- | --- |
| `preClientLaunch` | Before Arma 3 starts (blocking) |
| `postClientLaunch` | After the Arma 3 process starts |
| `onClientConnected` | When Arma 3 registers its API callback |
| `preClientStop` | Before "Stop Arma 3" closes the game (blocking) |
| `postClientStop` | After Arma 3 is closed |
| `onClientExit` | When Arma 3 exits |
| `preServerLaunch` | Before the dedicated server starts (blocking) |
| `postServerLaunch` | After the dedicated server process starts |
| `onServerConnected` | When the dedicated server registers its API callback |
| `preServerStop` | Before the dedicated server is stopped (blocking) |
| `postServerStop` | After the dedicated server is stopped |
| `onServerCrash` | When the dedicated server exits without a stop request |
| `preReload` | Before a saved file is reloaded (blocking, cancellable) |
| `postReload` | After a successful reload |
| `onReloadError` | When a reload or compile fails |
| `preReloadAll` | Before "Reload all functions" (blocking, cancellable) |
| `postReloadAll` | After all functions were reloaded |
| `postMissionRestart` | After mission functions were restarted |
| `preSetup` | Before project setup (blocking, cancellable) |
| `postSetup` | After project setup |
| `preJunction` | Before junctions are created (blocking, cancellable) |
| `postJunctionCleanup` | After junctions are removed |
| `postScaffold` | After the example project is created |
| `onModConfigChanged` | When a mod launch role changes |
| `onSettingsChanged` | When the project settings file is saved |
| `preMissionLink` | Before a mission is linked (blocking, cancellable) |
| `postMissionLink` | After a mission is linked |
| `preHostMission` | Before a mission is hosted (blocking, cancellable) |
| `postHostMission` | After a mission is hosted |

## Troubleshooting

**Only `config.cpp` (or an old copy) is visible in `z\<tag>\addons\<addon>`.** A real folder is
sitting on the mount path, so the extension cannot create its junction there; Arma then reads
that stale folder instead of your workspace sources. On startup, **Play**, and **Set up this
mod**, the extension offers to move the folder to `<Arma 3>\.sqfreloader-backups` and replace it
with a junction. Accept the prompt, or delete/rename the folder and run
**SqfReloader: Set up this mod** again.

**The extension cannot find Arma.** Set `armaDirectory` to the folder containing
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
