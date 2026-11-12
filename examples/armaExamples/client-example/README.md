# Client mod example

This directory is a workspace example for a client-side Arma mod development setup for **SqfReloader**.

```text
ClientMod/
  @ExampleMod/
    mod.cpp
    .hemtt/project.toml
    addons/scripts/{config.cpp, $PBOPREFIX$, functions/*.sqf}
  missions/example.Altis/     single-player Eden mission
  mpmissions/example.Altis/   multiplayer Eden mission
```

Edit `fn_hello.sqf`, `fn_add.sqf` or `fn_showCounter.sqf`, save, and the running game
recompiles the function without a restart.

## Try live reload as a client

1. Click **Play Arma 3** in the VS Code status bar (bottom left), or run
   **SqfReloader: Play** from the Command Palette. Arma 3 starts with `@ExampleMod` and the
   SqfReloader mod.
2. Open the **Eden Editor** from Arma's main menu and choose or create a scenario. The
   SqfReloader API initializes in Eden; the status bar switches to **Arma 3** and the
   **Arma 3 SqfReloader** panel reports `API: Running`.
3. Open Arma's debug console (Eden Editor **Debug** menu) and run:

   ```sqf
   [] call example_fnc_hello;
   ```

   `systemChat` prints `Hello developer from ...` and the return value is the same string.
4. Edit the message in
   [fn_hello.sqf](./@ExampleMod/addons/scripts/functions/fn_hello.sqf), save with
   <kbd>Ctrl</kbd>+<kbd>S</kbd>, then run `[] call example_fnc_hello;` again. The running game
   prints the new text immediately; no mission restart is needed.
5. Open the **Arma 3 SqfReloader** view from the Activity Bar and click **Debug Console**. Run a
   command there, for example:

   ```sqf
   [] call example_fnc_showCounter;
   ```

   The result appears under **Result**. The Debug Console executes SQF in the same Arma
   instance through the extension's local API, so it reaches the Eden Editor too.
6. Place one object in the Eden world, then run this in the VS Code Debug Console to list the
   objects placed in the Eden scenario:

   ```sqf
   all3DENEntities select 0
   ```

## Jump from a call to its function

### Definitions

- Hover `example_fnc_add` to see the header documentation from `fn_add.sqf`: description, parameters and return value.
- <kbd>Ctrl</kbd>+click (or <kbd>F12</kbd>) on a function or variable to jump to its definition.
- Function and variable navigation are provided by `sqfReloader.functionLinks`, `sqfReloader.globalVariableLinks` and `sqfReloader.localVariableLinks`.

### References

- Right-click a function file (for example, `./@ExampleMod/addons/scripts/functions/fn_add.sqf`) in the VS Code Explorer and select **SqfReloader: See references**.
- This searches the workspace and shows the files where the corresponding function is called from.

## Close Arma and open the mission in Eden

1. When you are done, click the status-bar item again (it shows **Arma 3** while running) to
   stop Arma 3, or close the game normally. Force-closing the game also works; the workspace
   links are kept.
2. In the VS Code Explorer, right-click
   `ClientMod/missions/example.Altis/mission.sqm` and choose **SqfReloader: Open in Eden**.

Arma starts with the Eden Editor and that mission loaded, including its `init.sqf`,
`initServer.sqf`, `initPlayerLocal.sqf`, `initPlayerServer.sqf`, respawn scripts and the
mission-local `CfgFunctions` examples (`fn_preInit`, `fn_postInit`, `fn_liveTest`).
`allowFunctionsRecompile` is already enabled in `description.ext`, so mission functions can be
hot-reloaded too. The multiplayer mission in `mpmissions/` adds a `CfgRemoteExec` example and the
`fn_receiveReloadedFunction` callback used to broadcast recompiled functions to other clients.

## Files and HEMTT

The mod uses the `example` function tag, so its functions are `example_fnc_hello`,
`example_fnc_add` and `example_fnc_showCounter`. Its `$PBOPREFIX$` is
`z\example\addons\scripts`, which matches the path SqfReloader mounts the addon at, so
`hemtt check` works inside `@ExampleMod` without further setup. The extension never modifies an
existing `$PBOPREFIX$` or the project files; HEMTT writes its output to `.hemttout`, which the
workspace `.gitignore` excludes.

The extension's REST API is local to the development machine. Do not expose its port to an
untrusted network.
