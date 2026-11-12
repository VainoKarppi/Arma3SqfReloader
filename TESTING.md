# Testing checklist — unreleased build

What changed since `3.8.1` and what to exercise before publishing. Two ways to work through it:

- **Automated first** (no Arma needed): `npm run compile` → `npm run verify`. That covers the
  version gate, the project-settings cache and the guided-tour state machine.
- **In Arma second**: everything under [Manual checks](#manual-checks), in the order below. Each
  item says what to click and what "working" looks like.

The released behaviour is described in [README-FULL.md](./README-FULL.md); the support matrix in
[LIMITATIONS.md](./LIMITATIONS.md) must still match what you observe.

---

## 1. Automated checks

```powershell
npm run clean ; npm run compile          # must be error-free
npm run verify                           # version gate + links + tour/cache + HEMTT shim + scaffold + tags
node scripts/verify-links.js             # junction/mission-link logic (also run by verify)
node scripts/verify-tutorial.js          # guided tour + project-settings cache (also run by verify)
npx --no-install @vscode/vsce ls         # packaging: no dev files, out/ has one .js per module
```

Expected:

| Check | Passes when |
| --- | --- |
| `npm run compile` | No TypeScript errors. Uses `@types/vscode` `~1.99.0`, so an API newer than the declared engine fails here. |
| `npm run verify:version` | Prints `Version <x.y.z> is consistent across 7 places`. |
| `scripts/verify-links.js` | Ends with `All link checks passed.` (broken junction replaced, mission links registered and cleaned up, real folders untouched). |
| `scripts/verify-tutorial.js` | Ends with `All tutorial and settings-cache checks passed.` |
| `scripts/verify-hemtt-shim.js` | Ends with `All HEMTT shim checks passed.` (skips itself off Windows). |
| `scripts/verify-template.js` | Ends with `TEMPLATE VERIFY PASSED`. |
| `scripts/verify-tags.js` | Ends with `TAG VERIFY PASSED`. |
| `vsce ls` | No `src/`, `scripts/`, `*.map`, `node_modules`; `out/` has exactly one `.js` per source module. |

Negative test for the version gate (optional, takes a second): change `Version = "x.y.z"` in
`SqfReloaderExtension/src/BuildStamp.cs` to something else, run `npm run verify:version` — it must
fail and name every file. Revert afterwards.

---

## 2. Manual checks

Build the extension first (`build-all.ps1` or `npm run compile` and press F5 with the repository
open), then work through the sections. Reload the VS Code window after installing.

### 2.1 Guided tour (new)

Setup: an **empty folder** in a fresh VS Code window.

1. Run **SqfReloader: Create example mod**.
2. A toast asks *"Start the SqfReloader guided tour?"* → choose **Start tour**.
3. The **Arma Project** view opens by itself with a checklist below the status block.

Check, in order:

- [ ] The tour shows `1/7`, not `0/7`: **Create the project settings** is already ticked, because
      the example command wrote `.vscode/sqfReloader-settings.json`.
- [ ] Click **Play Arma 3** from the view/status bar and start a mission or Eden. The **Play Arma 3**
      step ticks itself (no checkbox click needed).
- [ ] Open and save `ClientMod/@ExampleMod/addons/scripts/functions/fn_hello.sqf`. **Edit an SQF
      function** and **Save and see the reload** both tick.
- [ ] Open **Debug Console** from the view. **Run code in the Debug Console** ticks.
- [ ] Tick **Open the example mission** and **Hover a function name or jump to it** by hand. Ticks
      stay after a window reload (progress is per workspace).
- [ ] **Read more** on a step opens `ClientMod/README.md` scrolled to the matching heading.
- [ ] **Reset** clears the ticks; the tour stays visible.
- [ ] Close the view, reopen it: the tour is still there with its progress.
- [ ] Reopen the workspace (`File → Reload Window`): the tour does **not** ask again, and the
      checklist is still shown with the same progress.

Not-offered cases:

- [ ] In a **non-example** workspace (any folder without `ClientMod/@ExampleMod`) no tour section
      appears, and **SqfReloader: Start the guided tour** explains that it only works in an example
      workspace.
- [ ] In a new example workspace choose **Not now**: the offer does not repeat, and the sidebar
      section stays hidden until **SqfReloader: Start the guided tour** is run.

### 2.1b Empty workspace first run

- [ ] Open an **empty folder** in a fresh window. Within a couple of seconds a notification in the
      bottom-right reads *"This workspace has no Arma mod yet. Create an example mod to try live
      reload?"* with **Create example mod** and **Don't ask again** — no "Completed installing
      extension" wording.
- [ ] The offer is **per workspace**: close the toast, open another empty folder, and it appears
      there too. It does not repeat in the same folder.
- [ ] Open the **Arma Project** view in the empty folder: instead of a "create project settings"
      question it shows a **No Arma project yet** banner with **Create example mod**.
- [ ] Click **Create example mod** in the toast (or the banner): the **Arma Project** view opens with
      a **Example mod is ready** banner above the status lines. It has **two blue buttons** — **Play
      Arma 3** and **Start dedicated server** — plus a plain **Dismiss** link.
- [ ] At the same time a separate notification asks *"Start the SqfReloader guided tour?"* with
      **Start tour** / **Not now** (the ready message is no longer a notification, so the two never
      replace each other).
- [ ] **Start dedicated server** in the banner starts the server and the banner disappears;
      **Play Arma 3** likewise launches the game.
- [ ] Run **SqfReloader: Create example mod** again: the banner returns (and the tour question too,
      even after an earlier *Not now*).
- [ ] **Dismiss** hides the banner, and switching to another workspace also clears it.
- [ ] Answer **Start tour** in the tour notification: the Arma Project view opens with the checklist
      at `1/7` (**Create the project settings** already ticked).
- [ ] In another empty folder choose **Don't ask again** on the create-example toast: it does not
      appear in any later folder. **SqfReloader: Show the create-example offer again** brings it back.

### 2.1c Links are never left behind

- [ ] With Arma closed, close the VS Code window (or **Developer: Reload Window**). Afterwards
      `<Arma 3>\z\<tag>\addons\<addon>`, the `@Mod` link (module mode) and
      `<profile>\Missions\example.Altis` are gone.
- [ ] Disable the extension (Extensions view → Disable): the same junctions disappear.
- [ ] With **Arma running**, close VS Code: the links stay (they are removed when the game exits) and
      the output channel explains that.
- [ ] Run **SqfReloader: Play Arma 3** again: all links come back and the mission appears in Eden.

### 2.2 Stop only the Arma VS Code started
- [ ] Start Arma from VS Code, then run **SqfReloader: Stop Arma 3**. The dialog says *"Close the
      Arma 3 instance started from VS Code?"* and only that instance closes. Output channel logs
      `Arma 3 (pid N) closed.`
- [ ] Start **two** Arma instances (one from VS Code, one from Steam with a different profile):
      stopping from VS Code must leave the Steam one running.
- [ ] With **only** an Arma started from Steam running, run **SqfReloader: Stop Arma 3**. The dialog
      warns *"…that VS Code did not start…"*. Cancelling changes nothing; confirming closes it and
      the output logs `Arma 3 closed (instance started outside VS Code).`
- [ ] **Stop dedicated server** still stops the server it started (and only that one).

### 2.2b Mission link cannot be created (Play must still launch)

Reproduce the reported blocker, then confirm the game still starts:

1. Link the example mission once (**Play Arma 3** once, or run `SqfReloader: Set up this mod`).
2. Close Arma, then delete the workspace copy of the mission: rename
   `ClientMod\missions\example.Altis` to `example.Altis.bak` (the junction now dangles), or move
   the whole `ClientMod` folder aside and back.

Check:

- [ ] **Play Arma 3** shows a warning *"Arma 3 will start, but the mission folder could not be
      linked…"* and **Arma still launches**.
- [ ] The output channel contains `Warning: the mission folder could not be linked:` with the
      reason, and **no** `launch failed` error.
- [ ] After restoring the mission folder, the next **Play** re-creates the junctions
      (`Junction created: …` in the output) and the mission shows up in Eden again.
- [ ] A **real folder** at the mission link path is never deleted: the warning names the path and
      the folder keeps its contents.

### 2.3 Idle polling and cached settings

- [ ] With Arma closed, leave VS Code idle for ~1 minute: the status bar keeps saying
      `Play Arma 3`, and the machine stays quiet (previously `tasklist` ran every 2 s).
- [ ] Click **Play Arma 3**: status updates within ~2 s of the launch (the loop wakes immediately).
- [ ] Edit `.vscode/sqfReloader-settings.json` in the editor (e.g. `"logLevel": "verbose"`), save:
      the next reload line is verbose, i.e. the cache is invalidated by the watcher.
- [ ] Change `"logLevel": "error"`, save, trigger an error: error lines still appear.

### 2.4 HEMTT through a `.cmd` shim (optional)

Only if HEMTT is installed via scoop/Chocolatey:

- [ ] `sqfReloader.hemtt.enabled` on, project contains `.hemtt/project.toml` → **SqfReloader: Run
      HEMTT check** finishes and lists problems; the output does not say "hemtt command not found".

### 2.5 Regression: the normal workflow still works

- [ ] **Create example mod** → **Play** → edit/save `fn_hello.sqf` → the change is visible in game.
- [ ] Ctrl+click a `TAG_fnc_name` still opens its definition and hover still shows the header.
- [ ] The Arma Project view still lists mods, watches, hooks and RPT output, and the Debug Console
      still executes SQF.

---

## 3. Release gate

Only after §1 and §2 pass, follow §3 of [PLAN.md](./PLAN.md) on a clean machine (fresh VS Code
profile, `.vsix` from `build-all.ps1`), and record the result in the release notes.
