# Arma 3 SQF Reloader (VS Code)

Write SQF in VS Code, press one button, and Arma 3 starts with your mod. Save a script and
the running game recompiles it immediately - no restart, no PBO rebuild, no manual `-mod=`
setup.

The extension is the front end of **SqfReloader**: a native Arma extension (`SqfReloader_x64.dll`)
plus a small mod (`@SqfReloader`) that exposes a local REST API inside the game. Both ship
inside the `.vsix`, so installing the extension is all a developer has to do.

```text
 VS Code (this extension)                    Arma 3
 ------------------------                    ------
 Install vsix  ->  ships SqfReloader_x64.dll + @SqfReloader
 "SqfReloader: Play"  ->  arma3_x64.exe -filePatching -noBattlEye
                          -mod="<your mod>";"<arma>\@SqfReloader"
      save fn_x.sqf
           | POST /api/reload {"functions":["mymod_fnc_x"]}
           +--------------------------------> SqfReloader_x64.dll (REST)
                                                   | ExtensionCallback
                                                   v
                                      @SqfReloader: compile <arma>\z\<tag>\addons\<addon>\...
                                                   | (junction to your working copy)
                                                   v
                                            missionNamespace mymod_fnc_x
```

---

## 1. Install (one time)

```powershell
code --install-extension arma3-sqf-reloader-<version>.vsix
```

Nothing else. The extension contains the complete `@SqfReloader` mod:

* `mod.cpp` and `logo.paa`,
* `addons\scripts.pbo` - the packed addon (prefix `scripts`, `config.cpp` + all `functions\`),
* `SqfReloader_x64.dll` (NativeAOT Arma extension with the REST server), in the mod root,
* the launcher that copies `@SqfReloader` into the Arma 3 folder and starts the game.

That folder is the only thing that gets installed into Arma 3 - no DLL next to
`arma3_x64.exe`, no `<Arma 3>\SqfReloader` folder, no `replacement\` folder and no unpacked
addon copy. Installing a newer `.vsix` replaces the whole `@SqfReloader` folder (new PBO, new
DLL) the next time you press **Play**.

The DLL sits in the **mod root** because Arma resolves extensions from the executable folder
or the mod root only - a `dll\` subfolder makes it report
`CallExtension 'SqfReloader' could not be found`.

To build the VSIX yourself, see [Building](#7-building-everything).

## 2. Try it in an empty folder

No mod yet? Open **any empty folder** in VS Code and run:

```
SqfReloader: Create example mod (try the reloader)
```

You get a complete, working mod plus a test mission:

```text
@ExampleMod/
  mod.cpp
  addons/example/
    $PBOPREFIX$              example\addons\example
    config.cpp               CfgPatches (SqfReloader_reloadable) + CfgFunctions tag "example"
    functions/fn_hello.sqf   example_fnc_hello   - writes a systemChat line
    functions/fn_add.sqf     example_fnc_add     - 20 + 22
    functions/fn_showCounter.sqf  example_fnc_showCounter - calls both
missions/example.Altis/      optional test mission (setting below)
    description.ext          SqfReloader >> StartupCode hook
    initPlayerLocal.sqf      calls the functions 2 s after spawn
.vscode/settings.json        sqfReloader.* defaults for this project
```

The command links the mod into your Arma 3 folder right away and offers **Play Arma 3**.
Existing files are never overwritten: run it again and you are asked before the template
files are recreated (`sqfReloader.createExampleWithMission` controls the mission).

Then try the reload:

1. **SqfReloader: Play**, wait until the status bar turns green.
2. Open `fn_hello.sqf`, change the message, save.
3. In the debug console run `[] call example_fnc_hello;` - the new text appears.

`missions/example.Altis` does the same on spawn, so you can also just open that mission in
Eden and press *Play*.

## 3. Start Arma 3 with your own mod

1. Open your mod folder in VS Code (the folder with `addons\` and `mod.cpp`, e.g.
   `...\@MyMod`). The extension activates on `**/*.sqf`, `mod.cpp` and `$PBOPREFIX$`.
2. On first activation it detects the Arma 3 installation (registry, Steam libraries and
   common paths). Only if detection fails does it ask for the folder once and store it in
   `sqfReloader.armaDirectory`.
3. Click **SqfReloader** in the status bar, or run **SqfReloader: Play** from the command palette.

`Play` does all of this:

| Step | Detail |
| --- | --- |
| Deploy the runtime | copies the bundled `@SqfReloader` (`mod.cpp`, `logo.paa`, `addons\scripts.pbo`, `SqfReloader_x64.dll`) into `<Arma 3>\@SqfReloader` as a plain folder, replacing any older copy. Legacy `<Arma 3>\SqfReloader_x64.dll`, `<Arma 3>\SqfReloader`, `dll\`, `replacement\` and the unpacked addon copy are removed. |
| Link your mod | each folder with a `$PBOPREFIX$` becomes `<Arma 3>\z\<tag>\addons\<addon>`, a junction to your working copy. Your mod is *not* packed into a PBO. |
| Start the game | `arma3_x64.exe -filePatching -mod="<your mod>";"<Arma 3>\@SqfReloader" -noBattlEye` |
| Wait for the API | polls `GET /api/status` for up to 60 s, then the status bar turns green. |

No `-init=` parameter is needed: `@SqfReloader` starts itself from its own
`Cfg3DEN >> EventHandlers >> init` (the same hook EdenOnline uses), which the engine runs
whenever the Eden Editor display is created - on start-up, on mission new/load and when the
main menu starts a mission. `SqfReloader_fnc_runStartup` is safe to call repeatedly; it also runs
the mission's own `SqfReloader >> StartupCode` if the mission defines one.

`-filePatching` is required so Arma can read your junctioned mod. `-noBattlEye` is added because
BattlEye cannot load an unsigned extension; add `-be` to `sqfReloader.extraLaunchArguments` if you
really need it.

Already have Arma 3 running? **SqfReloader: Check connection** re-attaches instead of launching
a second instance.

## 4. Hot reload on save

Open a `fn_*.sqf` file and save it. The extension resolves the function name from the file
and the addon from the nearest `$PBOPREFIX$`, then sends:

```http
POST /api/reload
{"functions":["mymod_fnc_hello"]}
```

`@SqfReloader` recompiles the file from the junction inside the Arma folder and stores it as
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
        SqfReloader_reloadable[] = {"mymod_fnc_hello", "mymod_fnc_other"};
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
| `sqfReloader.armaDirectory` | `""` | Arma 3 folder; auto-detected when empty. |
| `sqfReloader.enabled` | `true` | Master switch for reload on save. |
| `sqfReloader.apiUrl` | `http://127.0.0.1:8765/api` | SqfReloader REST base URL. |
| `sqfReloader.requestTimeout` | `3000` | Request timeout in ms. |
| `sqfReloader.autoJunction` | `true` | Link the open mod into the Arma folder automatically. |
| `sqfReloader.junctionMode` | `addon` | `addon` (per `$PBOPREFIX$`) or `module` (whole `@Mod`). |
| `sqfReloader.reloadOnSave` | `reload` | `reload` (recompile the variable), `recompile` (content posted to `/api/command`), `off`. |
| `sqfReloader.notifyOnError` | `true` | Warn when Arma is not reachable or a reload fails. |
| `sqfReloader.extraLaunchArguments` | `-noSplash -skipIntro -noPause` | Extra parameters for `Play` (e.g. `-window -showScriptErrors`). `-filePatching` and `-noBattlEye` are added automatically. |
| `sqfReloader.createExampleWithMission` | `true` | **Create example mod** also writes the test mission. |

Example `.vscode/settings.json` of a mod project:

```json
{
    "sqfReloader.armaDirectory": "D:\\SteamLibrary\\steamapps\\common\\Arma 3",
    "sqfReloader.junctionMode": "addon",
    "sqfReloader.reloadOnSave": "reload",
    "sqfReloader.extraLaunchArguments": "-window -showScriptErrors -noSplash"
}
```

## 6. Commands

| Command | What it does |
| --- | --- |
| **SqfReloader: Create example mod (try the reloader)** | Writes `@ExampleMod` (+ test mission) into the open folder and links it; works in an empty workspace. |
| **SqfReloader: Play** | Deploys the runtime, links the mod and starts Arma 3. |
| **SqfReloader: Stop Arma 3** | Closes the running game. |
| **SqfReloader: Check connection** | `GET /api/status`; reports version, URL and whether the game callback is registered. |
| **SqfReloader: Set up this mod (junction + config)** | Detects Arma 3, links the mod, stores the Arma folder. Also in the Explorer context menu. |
| **SqfReloader: Set up all mods in this workspace** | Same for every workspace folder that looks like a mod. |
| **SqfReloader: Reload current function** | Recompiles the active file through `/api/eval`. |
| **SqfReloader: Reload all functions** | `POST /api/reload` without a filter. |
| **SqfReloader: Toggle reload on save** | Flips `sqfReloader.enabled`. |
| **SqfReloader: Remove junctions created by this extension** | Deletes only the links recorded in `.sqfreloader-links.json`. |
| **SqfReloader: Open Arma 3 folder** / **SqfReloader: Show output** | Explorer / extension log. |

## 7. Building everything

Requirements: .NET SDK 10, Visual Studio 2022 Build Tools with *Desktop development with
C++* (NativeAOT), Node.js 20+ and VS Code. Arma 3 Tools (AddonBuilder) is required: the
shipped addon is a `.pbo`.

```powershell
# DLL + mod + VSIX (and install it)
powershell -ExecutionPolicy Bypass -File build-all.ps1 -Install
```

`build-all.ps1` builds the native extension, packs
`SqfReloaderExtension\@SqfReloader\addons\scripts` with Arma 3 Tools AddonBuilder into
`addons\scripts.pbo` (prefix `scripts`, `-packonly` so `config.cpp` and the
`functions\*.sqf` stay readable), puts the DLL next to `mod.cpp`, bundles that mod folder into
`vscode-runtime/` inside the VSIX, compiles the TypeScript and packages
`arma3-sqf-reloader-<version>.vsix`.

The sources in `SqfReloaderExtension\@SqfReloader` are already laid out exactly like the shipped
mod (`mod.cpp`, `logo.paa`, `addons\scripts\`), so `dist\@SqfReloader` is that tree plus the
packed PBO and the DLL.

Every build increases the version by one patch level and writes the same number to
`SqfReloaderExtension.csproj` (+ `src\BuildStamp.cs`, which is what the DLL reports over REST),
`CfgPatches` in `config.cpp` and `package.json`/`package-lock.json`. Use `-NoVersionBump` to
rebuild the current version.

`-NoPbo` ships the unpacked addon folder instead of `scripts.pbo` (debugging only);
`-AddonBuilder <path>` points at a non-default `AddonBuilder.exe` (or set `%ARMA3_ADDONBUILDER%`).

| Output | Path |
| --- | --- |
| Native extension | `SqfReloaderExtension\dist\@SqfReloader\SqfReloader_x64.dll` |
| Packed addon | `SqfReloaderExtension\dist\@SqfReloader\addons\scripts.pbo` |
| Mod + installer zip | `SqfReloaderExtension\dist\@SqfReloader`, `dist\SqfReloader-Setup.zip` |
| VS Code extension | `arma3-sqf-reloader-<version>.vsix` (contains `vscode-runtime\mod\@SqfReloader`) |

Switches: `-InstallVsCode` / `-InstallArma` (only one half), `-SkipVsce` (compile only),
`-Clean` (rebuild the DLL from scratch and drop old `.vsix` files).
`-InstallArma` additionally runs the standalone installer
(`SqfReloaderExtension\tools\install.ps1`), which is only needed if you want to play without the
VS Code extension.

## 8. Troubleshooting

**`Arma 3 was not found` / `arma3_x64.exe not found`**
Set `sqfReloader.armaDirectory` to the folder that contains `arma3_x64.exe` (Steam: *Manage >
Browse local files*).

**Arma starts but the status bar stays grey**
Look at *SqfReloader: Show output*: the launch line shows the exact command line. Check that
`@SqfReloader` is listed in the game's *Expansions* and that the Arma `.rpt` log
(`%LOCALAPPDATA%\Arma 3\arma3_x64_*.rpt`) contains `SqfReloader`. The API only starts when the
Eden Editor display is created, so open a mission in Eden (or press Play) at least once.

**`CallExtension 'SqfReloader' could not be found`**
`SqfReloader_x64.dll` must be in the mod root (`<Arma 3>\@SqfReloader\SqfReloader_x64.dll`) or
next to `arma3_x64.exe`. A `dll\` subfolder is **not** searched by Arma. Re-run **Play** so the
extension redeploys the file.

**`SqfReloader is not listening on http://127.0.0.1:8765/api`**
The game runs, but the API did not start: launch through **SqfReloader: Play**, or start it
manually once per session with `[] call SqfReloader_fnc_apiStart;`. `SqfReloader_fnc_diagnose`
prints one line per possible problem.

**No `Play` possible (e.g. a launcher you cannot bypass)**
Add `-filePatching -mod="<Arma 3>\@SqfReloader" -noBattlEye` to the Steam launch options and
start the game normally; `@SqfReloader` starts the API from its `Cfg3DEN` init, so everything else
(hot reload, junctions) keeps working.

**`example_fnc_hello` is undefined in the example mod**
The function comes from `CfgFunctions`, so the mission must be started *with* `@ExampleMod`
(use **Play**, or enable it in *Expansions*). In the debug console
`[] call example_fnc_add;` is the quickest sanity check - it needs no dialog.

**A reload is queued but the game keeps running old code**
The path Arma compiles is `<Arma 3>\z\<tag>\addons\<addon>\...`. Check with *SqfReloader: Show
output* that the file is linked to your working copy, and that Arma sees the same prefix:
`"\z\<tag>\addons\<addon>\functions\fn_x.sqf"` must return `true` in `fileExists`.

**"already exists and points to a real folder"**
Something else already occupies that path (an installed PBO folder). Remove or rename it,
then run *SqfReloader: Set up this mod* again.

**Editing SqfReloader's own SQF**
The sources live in `SqfReloaderExtension\@SqfReloader\addons\scripts`. Edit them there (or use the
**Create example mod** template for your own mods) and rebuild with `build-all.ps1`; the shipped
`@SqfReloader` only contains `scripts.pbo`, so there is no unpacked copy to edit at runtime.

**Logs**
Extension log: *SqfReloader: Show output*; file log: `%LOCALAPPDATA%\SqfReloader\logs\SqfReloader.log`.

## 9. Developing the extension

```powershell
npm install
npm run compile          # or: npm run watch
# F5 in VS Code runs "Run Extension" (Extension Development Host)
npm run package          # vsix
node scripts\verify-template.js      # example mod template + mod discovery
node scripts\verify-tags.js          # $PBOPREFIX$ -> function tag rule
node scripts\verify-reloader.js      # file-patching config + reloader scripts
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
  reloader.ts            file-patching config + reloader.sqf generation
  launcher.ts            Play/Stop: start arma3_x64.exe, wait for the REST API
  arma.ts                Arma install + mod/$PBOPREFIX$ discovery
  junctions.ts           junction creation, registry, cleanup
  reload.ts              reload strategies (reload / recompile / eval fallback)
  api.ts                 SqfReloader REST client
  settings.ts            settings + output channel
vscode-runtime/          DLL + @SqfReloader copied into the VSIX by build-all.ps1 (generated)
SqfReloaderExtension/        native extension + Arma mod (C#, SQF, build/test tools)
build-all.ps1            builds DLL, mod and VSIX
scripts/                 verification helpers
```
