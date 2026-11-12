# Support matrix and limitations

This document records what Arma 3 SQF Reloader is expected to do today, what it is expected to do
but has not been verified, what must be fixed before a feature can be supported, and what is
deliberately out of scope.

It is a statement of intent, not a test report. Where a row says **Should work** the feature is
believed to work but has not been verified; treat it as unproven.

Status legend:

| Status | Meaning |
| --- | --- |
| **Working** | Implemented and used by the author; expected to work for the described setup. |
| **Should work** | Implemented and believed correct, but not verified for this combination. |
| **To be fixed** | A known gap. The feature is wanted, but it does not work reliably enough to be promised. |
| **Won't fix** | Out of scope by design, usually for security or platform reasons. |

---

## 1. Platforms and editors

| Environment | Status | Notes |
| --- | --- | --- |
| Windows 10 / 11, x64 | **Working** | The supported configuration. Windows-only APIs (`mklink /J`, `tasklist`, `taskkill`) and the bundled x64 DLL are used throughout. |
| Windows 11 on Arm64 | **Should work** | The x64 `SqfReloader_x64.dll` and Arma 3 run under x64 emulation. Activation shows a one-time warning; nothing has been verified on Arm64 hardware. |
| macOS / Linux desktop | **Won't fix** | Arma 3 with the SqfReloader mod is a Windows game; junctions and the DLL have no equivalent. The extension now says so and stays inactive. |
| VS Code Web (`vscode.dev`) | **Won't fix** | No local file system, no process launch, no junction. |
| Remote-SSH to a **Windows** host that has Arma installed | **Should work** | The extension is declared `extensionKind: ["workspace"]`, so it runs on the remote and manipulates that machine's Arma installation. Untested; the remote must run Windows with a desktop session for the game. |
| Remote-SSH / Dev Containers / WSL to a **Linux** host | **Won't fix** | The extension host is not Windows, so activation refuses to run. Running the Windows extension against a Linux Arma dedicated server is not supported. |
| VS Code Insiders, portable VS Code, other forks | **Should work** | Nothing depends on a specific VS Code build; language-model tool registration is skipped gracefully where `vscode.lm` is unavailable. |
| Untrusted / restricted-mode workspace | **Won't fix** | The extension launches processes, writes into the Arma installation and executes SQF in a live game. `capabilities.untrustedWorkspaces` is `false` by design. |
| Virtual workspaces (GitHub Repositories, remote file providers) | **Won't fix** | Junctions, `AddonBuilder` and `mission.sqm` handling need real local paths. |

---

## 2. Workspace layouts

| Layout | Status | Notes |
| --- | --- | --- |
| Single-folder workspace containing one mod | **Working** | The main supported workflow. |
| Single-folder workspace containing several mods | **Working** | Each discovered mod gets its own launch role. |
| Workspace with a mod **and** missions | **Working** | Missions are junctioned into the selected profile and the installation. |
| Unpacked addon without `mod.cpp` | **Working** | A generated `@Mod` folder with a `mod.cpp` is created next to the bundled mod. |
| Mod inside a Steam Workshop folder | **Should work** | A Workshop folder can be configured as an external mod; the extension only writes `-mod=`/`-serverMod=` entries and never edits the Workshop copy. |
| Workspace folder that is a copy of the mod in the Arma folder | **Working** | A folder that is both a workspace mod and an external mod is passed to Arma once. |
| **Multi-root workspace** | **To be fixed** | Project settings, the project view and save handling use the first workspace folder. Two Arma projects side by side will interfere with each other. |
| Workspace root that is not a mod and has no missions | **Working** | Commands explain what is missing instead of failing silently. |

---

## 3. Features

### 3.1 Launching and processes

| Feature | Status | Notes |
| --- | --- | --- |
| **Play** (start Arma with the workspace mod and `@SqfReloader`) | **Working** | Stages PBOs, links sources, writes the API config, starts `arma3_x64.exe`. |
| **Stop Arma 3** | **Working** | Closes only the instance VS Code started (its PID and children). If Arma was started elsewhere, the confirmation dialog says so before an image-name kill is used. |
| Launch with a pinned Steam path / non–Steam install | **Should work** | Arma discovery reads the registry and Steam library folders; `armaDirectory` pins a folder manually. |
| Launch when Steam is not running | **Working** | The extension starts Steam and waits for it. |
| Dedicated server (**Start dedicated server**) | **Working** | Requires a `.cfg` containing a real `hostname` assignment; the command line is shown before launch. |
| **Stop dedicated server** | **Working** | Stops the tracked process, otherwise `arma3server_x64.exe`. |
| **Host Mission** (`-host`) | **Working** | Only for missions under an `mpmissions` folder with `maxPlayers > 1`. |
| **Open in Eden** | **Working** | Opens the mission through the running Eden session; falls back to launching Arma. |
| Launch arguments with spaces or non-ASCII characters in paths | **Should work** | Quoting is implemented for `-mod=`, `-serverMod=`, `-name=` and scenario paths. |
| BattlEye-enabled launch | **Won't fix** | BattlEye refuses to load unsigned extensions. Launch adds `-noBattlEye` unless the argument is set explicitly; a BattlEye session will not have a reloader. |
| Arma 3 Profiling / Development branch | **Should work** | Nothing depends on the public branch specifically. |

### 3.2 Reloading and executing SQF

| Feature | Status | Notes |
| --- | --- | --- |
| Reload `fn_*.sqf` on save | **Working** | Compiles from a snapshot under `z\SqfReloader\Snapshots` and assigns the function in `missionNamespace`. |
| **Reload current function** | **Working** | |
| **Reload all functions** | **Working** | |
| **Reload and restart mission functions** | **Working** | Reruns `init.sqf`, `initServer.sqf`, `initPlayerLocal.sqf`; `initPlayerServer.sqf` on the server when `CfgRemoteExec` allows it. Collected garbage from `execVM` keeps running. |
| **Run in Arma** / **Run in Arma With Parameters** | **Working** | Returns the SQF result in the output channel. |
| Reload a `fn_*.sqf` inside a mission folder | **Working** | Compiles from a mission snapshot instead of an addon link. |
| Reload files that are not `fn_*.sqf` | **Working** | Requests an addon recompile; a `config.cpp` change needs a mission restart to take effect. |
| Multiplayer broadcast of a reload | **Working**, with a caveat | The running mission must permit `SqfReloader_fnc_receiveReloadedFunction` in `CfgRemoteExec`. |
| Duplicate function variable detection | **Working** | Blocks the reload and marks both files in the Problems panel. |
| Deleted function cleanup | **Working** | `clear`, `ask` or `keep` via `deletedFunctionBehavior`. |
| Two Arma instances at once | **To be fixed** | All instances compete for the single API port; the first one to start owns it. The other instance's reloads go to the wrong game. |

### 3.3 Project tooling

| Feature | Status | Notes |
| --- | --- | --- |
| Project settings panel (`.vscode/sqfReloader-settings.json`) | **Working** | Never reads or writes VS Code `settings.json`. |
| Mod launch roles (Client / Server / Not Used) | **Working** | The former Shared Mod role is gone; legacy `"both"` values read as Client. |
| External mods list (local and Workshop) | **Working** | |
| Mission linking into profile and installation | **Working** | Requires the profile folder to be writable. A mission that cannot be linked is a warning; Arma still launches. |
| Junction creation, repair and cleanup | **Working** | A real folder blocking a link is offered for backup into `<Arma 3>\.sqfreloader-backups`. A broken junction (deleted workspace) is replaced automatically on the next launch. |
| Remove junctions created by the extension | **Working** | Only removes links the extension owns: on **Stop Arma 3**, on Arma exit, when VS Code closes, and when the extension is disabled/uninstalled (kept while a game is running). |
| PBO staging through Arma 3 Tools `AddonBuilder` | **Working** | Staged PBO omits `.sqf` files and strips `CfgFunctions`; the source files are untouched. |
| Arma 3 Tools not installed | **Working** | Explains the requirement and offers to continue without PBOs. |
| Arma 3 Tools installed outside the registry entry | **Should work** | Set `sqfReloader.arma3ToolsDirectory` to override discovery. |
| Example project scaffold | **Working** | Writes `ClientMod/` (`@ExampleMod`, `missions`, `mpmissions`) and `ServerMod/` (`@ExampleServerMod`, mission, `server.cfg`), plus the workspace project settings. |
| Guided tour in the example workspace | **Working** | Checklist in the Arma Project view; only offered in workspaces created by the example command (or that still contain `ClientMod/@ExampleMod`). Progress is stored per workspace. |
| Status polling with Arma closed | **Working** | 15 s interval while nothing runs, 2 s while Arma or its API is up; commands refresh immediately. |
| `hemtt check` in the generated examples | **Working** | Both example mods ship `.hemtt/project.toml` and `$PBOPREFIX$`; verified with HEMTT 1.23. |
| Missing `$PBOPREFIX$` generation | **Working** | Offered once per HEMTT project per session, only when checks are enabled and `hemtt` resolves; derived from `project.toml` and verified with `hemtt check`. |
| Lifecycle hooks | **Working** | Blocking hooks can cancel an action; `${...}` and `SQFRELOADER_*` variables are expanded. |
| HEMTT checks (interval / on save / unsaved edits) | **Working** | Diagnostics come from `.hemttout/ci_annotations.txt`. |
| HEMTT installed as a `.cmd`/`.bat` shim (scoop, Chocolatey) | **Should work** | A shim is executed through `cmd.exe` with quoting; a real `.exe` on `PATH` still wins. Verified with a hand-made shim, not with every installer. |
| HEMTT with a custom lints set | **Working** | `sqfReloader.hemtt.lints`, `-L <lint>`. |

### 3.4 Editing features

| Feature | Status | Notes |
| --- | --- | --- |
| Ctrl+click / hover on `TAG_fnc_name` | **Working** | Uses `CfgFunctions` and `fn_*.sqf` names. |
| Global variable navigation | **Working** | Mission namespace only; `uiNamespace`/`profileNamespace` are not resolved. |
| File-local variable navigation and `params` | **Working** | Single document, scope-aware, cached per document version. |
| **See references** | **Working** | Works on a function name or inside a `fn_*.sqf` file. |
| Compile errors from the RPT as diagnostics | **Working** | Requires the RPT to be readable. |
| SQF syntax highlighting / IntelliSense | **Won't fix** for now | No grammar or language server ships. Use a dedicated SQF language extension; the navigation providers stay active for `*.sqf` regardless. |
| Debugging (breakpoints, stepping, call stack) | **Won't fix** for now | The Debug Console provides evaluation and watches, not a debug adapter. |

### 3.5 AI integration

| Feature | Status | Notes |
| --- | --- | --- |
| `#armaAiTool` — context, status, RPT, eval | **Working** | Requires a VS Code build with `vscode.lm` and a chat provider; evaluation asks for confirmation. |
| Interaction with non-Copilot agents | **Won't fix** for now | Only VS Code's language-model tool API is used. The local REST API is the integration point for anything else. |

### 3.6 Local REST API

| Feature | Status | Notes |
| --- | --- | --- |
| `GET /api/status`, `/api/functions`, `/api/docs` | **Working** | Bound to `127.0.0.1` by default. |
| `POST /api/eval`, `/api/execute`, `/api/reload`, `/api/send`, `/api/log`, `/api/command` | **Working** | Arbitrary SQF execution. |
| Calling the API from PowerShell / curl / a local tool | **Working** | See `examples/`. |
| Port already taken by another tool | **Working** | Falls back to the next free port and reports it. |
| Exposing the API beyond `127.0.0.1` | **Won't fix** | No authentication, no TLS and no origin checks. Setting `apiUrl` to a non-loopback host makes an unauthenticated RCE endpoint reachable from the network — this is documented as unsupported, not as a feature. |
| Requests from a web page in a browser | **Won't fix** | The API sends `Access-Control-Allow-Origin: *` and accepts unauthenticated requests, so any page the user visits can execute SQF. Until a token and origin checks exist (see *To be fixed*), do not browse untrusted sites with a game running. |

---

## 4. To be fixed

Features that are wanted and expected to work, but need work before they can be promised.

1. **Multi-root workspaces.** Resolve settings, mod roles and save handling from the folder that
   owns the file, not from `workspaceFolders[0]`.
2. **Two Arma instances on one machine.** Either give each instance its own port or explicitly
   report which instance owns the API.
3. **Local API authentication.** A per-install token, a request-body size cap, a JSON content-type
   requirement and no wildcard CORS, so a web page cannot drive the API. (Deliberately deferred
   from the first release; tracked in `PLAN.md`.)
4. **Remote-SSH to Windows.** Verify the extension end to end on a remote Windows host.
5. **Windows on Arm64.** Verify launch, junction and extension loading under x64 emulation.

---

## 5. Won't fix

Deliberately out of scope. Several are excluded specifically because supporting them would widen
the attack surface of an unauthenticated local code-execution endpoint.

1. **Running on macOS, Linux, VS Code Web, WSL or Dev Containers.** Arma 3 with SqfReloader is a
   Windows desktop game, and the extension needs junctions, `tasklist`/`taskkill` and a native
   Windows DLL.
2. **Remote or networked API access** (`apiUrl` pointing at another machine, opening a firewall
   port, exposing SQF execution to a LAN). The API has no authentication or TLS; exposing it would
   be remote code execution.
3. **Authenticating or sandboxing requests from web pages.** Superseded by item 5 above if it is
   ever implemented; until then the answer is "keep it on loopback".
4. **BattlEye-enabled sessions.** BattlEye will not load an unsigned extension.
5. **Untrusted and virtual workspaces.** The extension intentionally requires trust.
6. **An SQF grammar, language server or debug adapter in this release.** Use a dedicated SQF
   language extension; navigation providers in this extension keep working alongside it.
7. **PBO signing, Steam Workshop publishing and release builds.** The extension only stages PBOs so
   launches work; shipping a mod stays a HEMTT/manual workflow.
8. **Editing files inside another program's Steam Workshop directory.** External mods are passed
   by path and never modified.
9. **Multiplayer client attach.** The API is local to one Arma instance; remote clients are not
   attached individually.

---

## 6. Reporting a problem

If a row marked **Working** or **Should work** fails for you, include the extension version, your
Windows version, the Arma 3 branch, the mod layout (mod folder, addons, missions) and
`SqfReloader.log` from `%LOCALAPPDATA%\SqfReloader\logs\SqfReloader.log`.
