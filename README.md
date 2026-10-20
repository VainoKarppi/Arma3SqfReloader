# Arma 3 SQF Reloader (VS Code)

Write SQF in VS Code, press one button, and Arma 3 starts with your mod. Save a script and
the running game recompiles it immediately - no restart, no PBO rebuild, no manual `-mod=`
setup.

The extension is the front end of **ArmaApi**: a native Arma extension (`ArmaApi_x64.dll`)
plus a small mod (`@ArmaApi`) that exposes a local REST API inside the game. Both ship
inside the `.vsix`, so installing the extension is all a developer has to do.

```text
 VS Code (this extension)                    Arma 3
 ------------------------                    ------
 Install vsix  ->  ships ArmaApi_x64.dll + @ArmaApi
 "Arma API: Play"  ->  arma3_x64.exe -filePatching -noBattlEye
                          -mod="<your mod>";"<arma>\@ArmaApi"
      save fn_x.sqf
           | POST /api/reload {"functions":["mymod_fnc_x"]}
           +--------------------------------> ArmaApi_x64.dll (REST)
                                                   | ExtensionCallback
                                                   v
                                      @ArmaApi: compile <arma>\z\<tag>\addons\<addon>\...
                                                   | (junction to your working copy)
                                                   v
                                            missionNamespace mymod_fnc_x
```

---

## 1. Install (one time)

```powershell
code --install-extension arma3-sqf-reloader-<version>.vsix
```

Nothing else. The extension contains:

* `ArmaApi_x64.dll` (NativeAOT Arma extension with the REST server),
* `@ArmaApi` - `mod.cpp` plus `addons\armaapi.pbo` (packed with Arma 3 Tools AddonBuilder)
  and the plain SQF sources the PBO was built from,
* the launcher that deploys both into the Arma 3 folder and starts the game.

To build the VSIX yourself, see [Building](#7-building-everything).

## 2. Try it in an empty folder

No mod yet? Open **any empty folder** in VS Code and run:

```
Arma API: Create example mod (try the reloader)
```

You get a complete, working mod plus a test mission:

```text
@ExampleMod/
  mod.cpp
  addons/example/
    $PBOPREFIX$              example\addons\example
    config.cpp               CfgPatches (ArmaApi_reloadable) + CfgFunctions tag "example"
    functions/fn_hello.sqf   example_fnc_hello   - writes a systemChat line
    functions/fn_add.sqf     example_fnc_add     - 20 + 22
    functions/fn_showCounter.sqf  example_fnc_showCounter - calls both
missions/example.Altis/      optional test mission (setting below)
    description.ext          ArmaApi >> StartupCode hook
    initPlayerLocal.sqf      calls the functions 2 s after spawn
.vscode/settings.json        armaApi.* defaults for this project
```

The command links the mod into your Arma 3 folder right away and offers **Play Arma 3**.
Existing files are never overwritten: run it again and you are asked before the template
files are recreated (`armaApi.createExampleWithMission` controls the mission).

Then try the reload:

1. **Arma API: Play**, wait until the status bar turns green.
2. Open `fn_hello.sqf`, change the message, save.
3. In the debug console run `[] call example_fnc_hello;` - the new text appears.

`missions/example.Altis` does the same on spawn, so you can also just open that mission in
Eden and press *Play*.

## 3. Start Arma 3 with your own mod

1. Open your mod folder in VS Code (the folder with `addons\` and `mod.cpp`, e.g.
   `...\@MyMod`). The extension activates on `**/*.sqf`, `mod.cpp` and `$PBOPREFIX$`.
2. On first activation it detects the Arma 3 installation (registry, Steam libraries and
   common paths). Only if detection fails does it ask for the folder once and store it in
   `armaApi.armaDirectory`.
3. Click **Arma API** in the status bar, or run **Arma API: Play** from the command palette.

`Play` does all of this:

| Step | Detail |
| --- | --- |
| Deploy the runtime | copies the bundled DLL to `<Arma 3>\ArmaApi_x64.dll`, `<Arma 3>\ArmaApi\` and `<Arma 3>\@ArmaApi\dll\`, then links `<Arma 3>\@ArmaApi` to the bundled mod (only when it is missing). |
| Prepare hot reload | writes `@ArmaApi\replacement\armaapi\` (a file-patching `config.cpp` plus one `reloader.sqf` per `CfgFunctions` class) so ArmaApi's own PBO scripts stay reloadable. |
| Link your mod | each folder with a `$PBOPREFIX$` becomes `<Arma 3>\z\<tag>\addons\<addon>`, a junction to your working copy. |
| Start the game | `arma3_x64.exe -filePatching -mod="<your mod>";"<Arma 3>\@ArmaApi" -noBattlEye` |
| Wait for the API | polls `GET /api/status` for up to 60 s, then the status bar turns green. |

No `-init=` parameter is needed: `@ArmaApi` starts itself from its own
`Cfg3DEN >> EventHandlers >> init` (the same hook EdenOnline uses), which the engine runs
whenever the Eden Editor display is created - on start-up, on mission new/load and when the
main menu starts a mission. `ArmaApi_fnc_runStartup` is safe to call repeatedly; it also runs
the mission's own `ArmaApi >> StartupCode` if the mission defines one.

`-filePatching` is required both for your junctions and for ArmaApi's `replacement` config to
override the config inside `armaapi.pbo`. `-noBattlEye` is added because BattlEye cannot load
an unsigned extension; add `-be` to `armaApi.extraLaunchArguments` if you really need it.

Already have Arma 3 running? **Arma API: Check connection** re-attaches instead of launching
a second instance.

## 4. Hot reload on save

Open a `fn_*.sqf` file and save it. The extension resolves the function name from the file
and the addon from the nearest `$PBOPREFIX$`, then sends:

```http
POST /api/reload
{"functions":["mymod_fnc_hello"]}
```

`@ArmaApi` recompiles the file from the junction inside the Arma folder and stores it as
`mymod_fnc_hello` in `missionNamespace`, so the next call uses the new code.

| File saved | What happens |
| --- | --- |
| `fn_*.sqf` | that one function is recompiled |
| `config.cpp`, `*.hpp`, `init.sqf`, helpers | the mod's reloadable functions are recompiled |

Functions opt into reloading with `recompile = 1` in `CfgFunctions`: only those classes are
recompiled after a save (`init`/`runStartup` style entry points stay unmarked). Other mods opt
into reloading with one line in their `CfgPatches`:

```sqf
class CfgPatches {
    class mymod {
        ArmaApi_reloadable[] = {"mymod_fnc_hello", "mymod_fnc_other"};
    };
};
```

`TAG_fnc_name` is compiled from `\z\<tag>\addons\<tag>\source\fn_name.sqf`,
`\z\<tag>\addons\<tag>\functions\fn_name.sqf`, `\x\<tag>\addons\...` or an unpacked
`\@<tag>\addons\...`, which is why the junction matters: Arma must be able to read your
working copy at that path.

## 5. Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `armaApi.armaDirectory` | `""` | Arma 3 folder; auto-detected when empty. |
| `armaApi.enabled` | `true` | Master switch for reload on save. |
| `armaApi.apiUrl` | `http://127.0.0.1:8765/api` | ArmaApi REST base URL. |
| `armaApi.requestTimeout` | `3000` | Request timeout in ms. |
| `armaApi.autoJunction` | `true` | Link the open mod into the Arma folder automatically. |
| `armaApi.junctionMode` | `addon` | `addon` (per `$PBOPREFIX$`) or `module` (whole `@Mod`). |
| `armaApi.reloadOnSave` | `reload` | `reload` (recompile the variable), `recompile` (content posted to `/api/command`), `off`. |
| `armaApi.notifyOnError` | `true` | Warn when Arma is not reachable or a reload fails. |
| `armaApi.extraLaunchArguments` | `-noSplash -skipIntro -noPause` | Extra parameters for `Play` (e.g. `-window -showScriptErrors`). `-filePatching` and `-noBattlEye` are added automatically. |
| `armaApi.createExampleWithMission` | `true` | **Create example mod** also writes the test mission. |

Example `.vscode/settings.json` of a mod project:

```json
{
    "armaApi.armaDirectory": "D:\\SteamLibrary\\steamapps\\common\\Arma 3",
    "armaApi.junctionMode": "addon",
    "armaApi.reloadOnSave": "reload",
    "armaApi.extraLaunchArguments": "-window -showScriptErrors -noSplash"
}
```

## 6. Commands

| Command | What it does |
| --- | --- |
| **Arma API: Create example mod (try the reloader)** | Writes `@ExampleMod` (+ test mission) into the open folder and links it; works in an empty workspace. |
| **Arma API: Play** | Deploys the runtime, links the mod and starts Arma 3. |
| **Arma API: Stop Arma 3** | Closes the running game. |
| **Arma API: Check connection** | `GET /api/status`; reports version, URL and whether the game callback is registered. |
| **Arma API: Set up this mod (junction + config)** | Detects Arma 3, links the mod, stores the Arma folder. Also in the Explorer context menu. |
| **Arma API: Set up all mods in this workspace** | Same for every workspace folder that looks like a mod. |
| **Arma API: Reload current function** | Recompiles the active file through `/api/eval`. |
| **Arma API: Reload all functions** | `POST /api/reload` without a filter. |
| **Arma API: Toggle reload on save** | Flips `armaApi.enabled`. |
| **Arma API: Remove junctions created by this extension** | Deletes only the links recorded in `.armaapi-links.json`. |
| **Arma API: Open Arma 3 folder** / **Arma API: Show output** | Explorer / extension log. |

## 7. Building everything

Requirements: .NET SDK 10, Visual Studio 2022 Build Tools with *Desktop development with
C++* (NativeAOT), Node.js 20+ and VS Code. The `@ArmaApi` mod is packed into a `.pbo` with
**Arma 3 Tools AddonBuilder** (Steam > Library > Tools); when AddonBuilder is not installed the
build falls back to the bundled `PboBuilder`.

```powershell
# DLL + mod + VSIX (and install it)
powershell -ExecutionPolicy Bypass -File build-all.ps1 -Install
```

`build-all.ps1` builds the native extension, packs `addons\armaapi` into
`addons\armaapi.pbo` (AddonBuilder, prefix `z\armaapi`), copies the plain SQF sources next to
the PBO for hot reloads, bundles DLL + mod into `vscode-runtime/` inside the VSIX, compiles
the TypeScript and packages `arma3-sqf-reloader-<version>.vsix`.

Every build increases the version by one patch level and writes the same number to
`ArmaApiExtension.csproj` (+ `src\BuildStamp.cs`, which is what the DLL reports over REST),
`CfgPatches` in `config.cpp` and `package.json`/`package-lock.json`. Use `-NoVersionBump` to
rebuild the current version.

`-AddonBuilder <path>` points at a non-default `AddonBuilder.exe`; the build also accepts
`%ARMA3_ADDONBUILDER%`.

| Output | Path |
| --- | --- |
| Native extension | `ArmaApiExtension\dist\@ArmaApi\dll\ArmaApi_x64.dll` |
| Mod + installer zip | `ArmaApiExtension\dist\@ArmaApi`, `dist\ArmaApi-Setup.zip` |
| Editable ArmaApi SQF | `ArmaApiExtension\dist\@ArmaApi\source` |
| VS Code extension | `arma3-sqf-reloader-<version>.vsix` (contains `vscode-runtime\`) |

Switches: `-InstallVsCode` / `-InstallArma` (only one half), `-SkipVsce` (compile only),
`-Clean` (rebuild the DLL from scratch and drop old `.vsix` files).
`-InstallArma` additionally runs the standalone installer
(`ArmaApiExtension\tools\install.ps1`), which is only needed if you want to play without the
VS Code extension.

## 8. Troubleshooting

**`Arma 3 was not found` / `arma3_x64.exe not found`**
Set `armaApi.armaDirectory` to the folder that contains `arma3_x64.exe` (Steam: *Manage >
Browse local files*).

**Arma starts but the status bar stays grey**
Look at *Arma API: Show output*: the launch line shows the exact command line. Check that
`@ArmaApi` is listed in the game's *Expansions* and that the Arma `.rpt` log
(`%LOCALAPPDATA%\Arma 3\arma3_x64_*.rpt`) contains `ArmaApi`.

**`ArmaApi is not listening on http://127.0.0.1:8765/api`**
The game runs, but the API did not start: launch through **Arma API: Play**, or start it
manually once per session with `[] call ArmaApi_fnc_apiStart;`. `ArmaApi_fnc_diagnose`
prints one line per possible problem.

**No `Play` possible (e.g. a launcher you cannot bypass)**
Add `-filePatching -mod="<Arma 3>\@ArmaApi" -noBattlEye` to the Steam launch options and
start the game normally; `@ArmaApi` starts the API from its `Cfg3DEN` init, so everything else
(hot reload, junctions) keeps working.

**`example_fnc_hello` is undefined in the example mod**
The function comes from `CfgFunctions`, so the mission must be started *with* `@ExampleMod`
(use **Play**, or enable it in *Expansions*). In the debug console
`[] call example_fnc_add;` is the quickest sanity check - it needs no dialog.

**A reload is queued but the game keeps running old code**
The path Arma compiles is `<Arma 3>\z\<tag>\addons\<addon>\...`. Check with *Arma API: Show
output* that the file is linked to your working copy, and that Arma sees the same prefix:
`"\z\<tag>\addons\<addon>\functions\fn_x.sqf"` must return `true` in `fileExists`.

**"already exists and points to a real folder"**
Something else already occupies that path (an installed PBO folder). Remove or rename it,
then run *Arma API: Set up this mod* again.

**Editing ArmaApi's own SQF**
Open `vscode-runtime\mod\armaapi-src` (or `ArmaApiExtension\addons\armaapi` before a build) in
VS Code. ArmaApi ships as a PBO, so `Play` regenerates
`<Arma 3>\@ArmaApi\replacement\armaapi\` (a patched `config.cpp` with a `reloader` per
`CfgFunctions` class plus copies of the `fn_*.sqf` files). Editing those files and pressing
*Play* again recompiles the changed class; `fn_init`/`fn_runStartup` are intentionally never
reloaded.

**Logs**
Extension log: *Arma API: Show output*; file log: `%LOCALAPPDATA%\ArmaApi\logs\ArmaApi.log`.

## 9. Developing the extension

```powershell
npm install
npm run compile          # or: npm run watch
# F5 in VS Code runs "Run Extension" (Extension Development Host)
npm run package          # vsix
node scripts\verify-template.js      # example mod template + mod discovery
node scripts\verify-tags.js          # $PBOPREFIX$ -> function tag rule
node scripts\verify-reloader.js      # file-patching config + reloader scripts for the PBO
node scripts\verify-launch-args.js --workspace <modFolder> [--arma <armaFolder>]
                                     # deploys the runtime + junctions, prints the command line
node scripts\verify-extension.js <modFolder> <armaFolder>   # logic test against a live API
```

`ARMA_API_TEST_OUTPUT=<file>` makes the extension run one command shortly after activation
(`ARMA_API_TEST_TEMPLATE=1` for **Create example mod**, otherwise `Play`) and mirror its log
into that file, which is how the launcher and the template are verified without UI
automation.

Repository layout:

```text
src/                     VS Code extension (TypeScript)
  extension.ts           activation, commands, save handler, status bar
  scaffold.ts            "Create example mod" template writer
  runtime.ts             bundled DLL/mod deployment, junctions, config
  reloader.ts            file-patching config + reloader.sqf generation for the ArmaApi PBO
  launcher.ts            Play/Stop: start arma3_x64.exe, wait for the REST API
  arma.ts                Arma install + mod/$PBOPREFIX$ discovery
  junctions.ts           junction creation, registry, cleanup
  reload.ts              reload strategies (reload / recompile / eval fallback)
  api.ts                 ArmaApi REST client
  settings.ts            settings + output channel
vscode-runtime/          DLL + @ArmaApi copied into the VSIX by build-all.ps1 (generated)
ArmaApiExtension/        native extension + Arma mod (C#, SQF, build/test tools)
build-all.ps1            builds DLL, mod and VSIX
scripts/                 verification helpers
```
