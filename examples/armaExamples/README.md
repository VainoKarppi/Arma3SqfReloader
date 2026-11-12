# Arma example templates

These are the editable source files used by **SqfReloader: Create example mod**:

- `client-example/` is copied to `ClientMod/` in the opened workspace. It contains the
  `@ExampleMod` client mod, optional `missions/example.Altis` and `mpmissions/example.Altis` test
  missions (copied when mission creation is enabled in the project settings), the `.hemtt`
  project inside `@ExampleMod` that makes `hemtt check` work out of the box, and a README with a
  client-side walkthrough.
- `server-example/` is copied to `ServerMod/`. It contains `@ExampleServerMod` (with its own
  `.hemtt` project), `ExampleMission.Altis`, `server.cfg` and a README.
- `workspace-settings.json` becomes `.vscode/sqfReloader-settings.json` at the workspace root and
  gives both generated mods their launch role (`ClientMod/@ExampleMod` = client,
  `ServerMod/@ExampleServerMod` = server).

Resulting workspace layout:

```text
ClientMod/
  @ExampleMod/
    .hemtt/project.toml
    mod.cpp
    addons/scripts/{config.cpp, $PBOPREFIX$, functions/*.sqf}
  missions/example.Altis/
  mpmissions/example.Altis/
  README.md
ServerMod/
  @ExampleServerMod/
    .hemtt/project.toml
    mod.cpp
    addons/server/{config.cpp, $PBOPREFIX$, functions/*.sqf}
  ExampleMission.Altis/
  server.cfg
  README.md
.vscode/sqfReloader-settings.json
.gitignore
```

The `.gitignore` is created (or extended) with `**/.hemttout/`, so the build output HEMTT writes
for both nested projects stays out of git. An existing `.gitignore` is only appended to, and only
when it has no equivalent `.hemttout` rule yet.

The `$PBOPREFIX$` files match the path SqfReloader mounts each addon at
(`z\example\addons\scripts`, `z\Example\addons\server`), which is what HEMTT needs for
`hemtt check`. The extension never reads or rewrites them, and they are left out of the staged
launch PBO so the PBO prefix stays the addon name.

Edit these files to change what the command creates. Once generated, project settings belong to
the workspace user and are not overwritten, even when recreating the example.
