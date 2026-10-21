import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { findMods, Mod } from "./arma";
import { log, readSettings } from "./settings";
import { startupScript } from "./runtime";

/** Tag of the generated example mod; drives the SqfReloader runtime path and function names. */
export const TEMPLATE_TAG = "example";
export const TEMPLATE_MOD_NAME = "@ExampleMod";

export interface ScaffoldOptions {
    /** Folder that receives the mod (defaults to the first workspace folder). */
    target?: string;
    /** Also create a minimal test mission that shows the example dialog. */
    mission?: boolean;
    /** Overwrite existing template files. */
    force?: boolean;
}

export interface ScaffoldResult {
    modDirectory: string;
    /** Files created in this run. */
    files: string[];
    /** Template files that already existed and were left untouched. */
    skipped: string[];
    /** Single-player mission (missions\example.Altis). */
    missionDirectory?: string;
    /** Multiplayer mission (mpmissions\example.Altis). */
    mpMissionDirectory?: string;
}

/**
 * Creates a ready-to-run example mod in an (empty) workspace, so the reloader can be tried out
 * without writing any boilerplate.
 */
export async function scaffoldExample(options: ScaffoldOptions = {}): Promise<ScaffoldResult | undefined> {
    const settings = readSettings();
    const target = options.target ?? firstWorkspaceFolder();

    if (!target) {
        vscode.window.showWarningMessage("Open a folder in VS Code first: the example mod is created inside the workspace.");
        return undefined;
    }

    const existing = exampleMod(target);
    const withMission = options.mission ?? settings.createExampleWithMission;
    appendScaffoldLog(`TEMPLATE start target=${target} mission=${withMission} existing=${existing ? existing.name : "none"}`);

    // Confirmation prompts block a headless run (ARMA_API_TEST_OUTPUT), so they are skipped there.
    if (existing && options.target === undefined && !process.env.ARMA_API_TEST_OUTPUT) {
        const answer = await vscode.window.showInformationMessage(
            `${TEMPLATE_MOD_NAME} already exists in this workspace. Create the template files again?`,
            "Recreate files",
            "Cancel"
        );

        if (answer !== "Recreate files") {
            return undefined;
        }
    }

    const result = writeTemplate(target, withMission, options.force ?? existing !== undefined);
    appendScaffoldLog(`TEMPLATE written ${result.files.length} files`);
    log(`Example mod: ${result.modDirectory}`);

    for (const file of result.files) {
        log(`  created ${file}`);
    }

    for (const file of result.skipped) {
        log(`  kept existing ${file}`);
    }

    await revealExample(result);

    if (settings.autoJunction && !settings.armaDirectory) {
        log("No Arma 3 folder configured yet; it is detected or asked for on the first Play.");
    }

    const readyNotification = vscode.window.showInformationMessage(
        `Example mod ready. Click Play to start Arma 3 with it.`,
        "Play Arma 3"
    );
    const notificationTimeout = setTimeout(() => {
        // VS Code's message API has no per-notification timeout. Closing the notification
        // resolves the message promise with undefined if the user did not choose an action.
        void vscode.commands.executeCommand("workbench.action.closeNotification");
    }, 7_000);
    const choice = await readyNotification;
    clearTimeout(notificationTimeout);

    if (choice === "Play Arma 3") {
        void vscode.commands.executeCommand("sqfReloader.play");
    }

    return result;
}

/**
 * Writes the template without touching the VS Code UI (also used by scripts/verify-template.js).
 * Existing files are only overwritten with force=true.
 */
export function writeTemplate(root: string, withMission: boolean, force: boolean): ScaffoldResult {
    const modDirectory = path.join(root, TEMPLATE_MOD_NAME);
    const addonDirectory = path.join(modDirectory, "addons", TEMPLATE_TAG);
    const files: string[] = [];
    const skipped: string[] = [];

    const write = (file: string, content: string): void => {
        if (fs.existsSync(file) && !force) {
            skipped.push(file);
            return;
        }

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content.replace(/\r?\n/g, "\r\n"), "utf8");
        files.push(file);
    };

    // No $PBOPREFIX$ file: SqfReloader derives its runtime path from the layout and CfgFunctions,
    // leaving the template free of packaging metadata and bookkeeping files.
    write(path.join(modDirectory, "mod.cpp"), modCpp());
    write(path.join(addonDirectory, "config.cpp"), configCpp());

    // SqfReloader_fnc_reloadFunction looks for z\<tag>\addons\<tag>\functions\fn_<name>.sqf, so the
    // function files live flat in functions/ (not in per-class sub folders).
    write(path.join(addonDirectory, "functions", "fn_hello.sqf"), fnHello());
    write(path.join(addonDirectory, "functions", "fn_add.sqf"), fnAdd());
    write(path.join(addonDirectory, "functions", "fn_showCounter.sqf"), fnShowCounter());
    write(path.join(root, ".vscode", "settings.json"), vscodeSettings());

    let missionDirectory: string | undefined;
    let mpMissionDirectory: string | undefined;

    if (withMission) {
        missionDirectory = writeMission(path.join(root, "missions", `${TEMPLATE_TAG}.Altis`), write, false);
        mpMissionDirectory = writeMission(path.join(root, "mpmissions", `${TEMPLATE_TAG}.Altis`), write, true);
    }

    return { modDirectory, files, skipped, missionDirectory, mpMissionDirectory };
}

/**
 * Writes one test mission: a mission.sqm (Eden needs it), description.ext and the init script.
 * The multiplayer copy gets the MP header keys, so it shows up in the host/join lists.
 */
function writeMission(directory: string, write: (file: string, content: string) => void, multiplayer: boolean): string {
    write(path.join(directory, "mission.sqm"), missionSqm(multiplayer));
    write(path.join(directory, "description.ext"), descriptionExt(multiplayer));
    write(path.join(directory, "initPlayerLocal.sqf"), missionInitPlayerLocal());
    write(path.join(directory, "functions", "fn_liveTest.sqf"), missionLiveTest());

    return directory;
}

/** The generated example mod, when it exists in the workspace. */
export function exampleMod(root: string): Mod | undefined {
    return findMods(root).find(mod => mod.name.toLowerCase() === TEMPLATE_MOD_NAME.toLowerCase());
}

async function askForMission(): Promise<boolean> {
    const choice = await vscode.window.showQuickPick(
        [
            { label: "Mod + test mission", description: "Also writes missions\\example.Altis (SP) and mpmissions\\example.Altis (MP), which call the functions on spawn.", value: true },
            { label: "Mod only", description: "Use the example functions in your own mission.", value: false }
        ],
        { title: "Arma 3 SQF Reloader: example mod", ignoreFocusOut: true }
    );

    return choice?.value ?? true;
}

/** Opens the two files a developer edits first. */
async function revealExample(result: ScaffoldResult): Promise<void> {
    const hello = result.files.find(file => file.endsWith("fn_hello.sqf"));
    const config = result.files.find(file => file.endsWith("config.cpp"));

    for (const file of [config, hello]) {
        if (!file) {
            continue;
        }

        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            await vscode.window.showTextDocument(document, { preview: false });
        } catch (error) {
            log(`Could not open ${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

function firstWorkspaceFolder(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Dev aid: with ARMA_API_TEST_OUTPUT set, each scaffold step is appended to that file. */
function appendScaffoldLog(line: string): void {
    const target = process.env.ARMA_API_TEST_OUTPUT;

    if (!target) {
        return;
    }

    try {
        require("fs").appendFileSync(target, `${line}\n`, "utf8");
    } catch {
        // Best effort only.
    }
}
function modCpp(): string {
    return `name = "Example Mod";
author = "Arma 3 SQF Reloader";
actionName = "";
action = "";
dir = "@ExampleMod";
hideName = 0;
hidePicture = 0;
logo = "";
logoOver = "";
picture = "";
tooltip = "Example Mod";
tooltipOwned = "Example Mod";
overview = "Minimal mod generated by the Arma 3 SQF Reloader VS Code extension. Save fn_hello.sqf while Arma 3 is running and the change is live immediately.";
description = "Example Mod - hot reload playground";
`;
}

function configCpp(): string {
    return `class CfgPatches {
    class ${TEMPLATE_TAG} {
        units[] = {};
        weapons[] = {};
        requiredVersion = 2.02;
        requiredAddons[] = {"A3_Functions_F"};
        author = "Arma 3 SQF Reloader";
        version = "1.0.0";
        versionStr = "1.0.0";
        versionAr[] = {1, 0, 0};

    };
};

class CfgFunctions {
    class ${TEMPLATE_TAG} {
        tag = "${TEMPLATE_TAG}";

        class Core {
            file = "\\${TEMPLATE_TAG}\\functions";

            class hello { recompile = 1; };
            class add { recompile = 1; };
            class showCounter { recompile = 1; };
        };
    };
};
`;
}

function fnHello(): string {
    return `// ${TEMPLATE_TAG}_fnc_hello
// Debug console:  [] call ${TEMPLATE_TAG}_fnc_hello;
// Then edit this text, save, and call it again: the running game uses the new code.
params [["_name", "developer", [""]]];

private _message = format ["Hello %1 from %2", _name, "${TEMPLATE_TAG}\\addons\\${TEMPLATE_TAG}\\functions\\fn_hello.sqf"];
systemChat _message;

_message
`;
}

function fnAdd(): string {
    return `// ${TEMPLATE_TAG}_fnc_add - plain function used by the example dialog.
params [["_a", 0, [0]], ["_b", 0, [0]]];

_a + _b
`;
}

function fnShowCounter(): string {
    return `// ${TEMPLATE_TAG}_fnc_showCounter
// Debug console:  [] call ${TEMPLATE_TAG}_fnc_showCounter;
private _sum = [20, 22] call ${TEMPLATE_TAG}_fnc_add;

systemChat format ["20 + 22 = %1 (edit fn_add.sqf, save, call again)", _sum];
sleep 0.2;
[] call ${TEMPLATE_TAG}_fnc_hello;

_sum
`;
}

/**
 * Eden scenario file for the example test mission.
 *
 * Both variants place a BLUFOR fire team and an OPFOR fire team on Altis so the test mission
 * has something to shoot at. The multiplayer variant marks the OPFOR team leader playable
 * (`isPlayable=1`) with a speaker/pitch custom attribute, which is what makes the mission show
 * up as a hostable/joinable MP scenario.
 */
function missionSqm(multiplayer: boolean): string {
    const missionEntities = multiplayer ? missionEntitiesMultiplayer() : missionEntitiesSingleplayer();

    return `version=54;
class EditorData
{
	moveGridStep=1;
	angleGridStep=0.2617994;
	scaleGridStep=1;
	autoGroupingDist=10;
	toggles=1;
	class ItemIDProvider
	{
		nextID=10;
	};
	class Camera
	{
		pos[]={9971.6152,38.041138,11984.754};
		dir[]={-0.089041486,-0.3954865,0.91415292};
		up[]={-0.038340669,0.91847187,0.39362833};
		aside[]={0.99529487,2.7590431e-08,0.096944958};
	};
};
binarizationWanted=0;
sourceName="example";
addons[]=
{
	"A3_Characters_F"
};
class AddonsMetaData
{
	class List
	{
		items=1;
		class Item0
		{
			className="A3_Characters_F";
			name="Arma 3 Alpha - Characters and Clothing";
			author="Bohemia Interactive";
			url="https://www.arma3.com";
		};
	};
};
randomSeed=1;
class ScenarioData
{
	author="Razer";
};
class Mission
{
	class Intel
	{
		timeOfChanges=1800.0002;
		startWeather=0.30000001;
		startWind=0.1;
		startWaves=0.1;
		forecastWeather=0.30000001;
		forecastWind=0.1;
		forecastWaves=0.1;
		forecastLightnings=0.1;
		year=2035;
		month=6;
		day=24;
		hour=12;
		minute=0;
		startFogDecay=0.014;
		forecastFogDecay=0.014;
	};
	class Entities
	{
		items=2;
${missionEntities}
	};
};
`;
}

/** Single-player variant: BLUFOR fire team with the player as team leader, plus an OPFOR team. */
function missionEntitiesSingleplayer(): string {
    return `		class Item0
		{
			dataType="Group";
			side="West";
			class Entities
			{
				items=4;
				class Item0
				{
					dataType="Object";
					class PositionInfo
					{
						position[]={9959.3701,11.814472,12038.22};
					};
					side="West";
					flags=7;
					class Attributes
					{
						rank="SERGEANT";
						isPlayer=1;
					};
					id=1;
					type="B_Soldier_TL_F";
				};
				class Item1
				{
					dataType="Object";
					class PositionInfo
					{
						position[]={9964.3701,11.917388,12033.22};
					};
					side="West";
					flags=5;
					class Attributes
					{
						skill=0.44999999;
						rank="CORPORAL";
					};
					id=2;
					type="B_soldier_AR_F";
				};
				class Item2
				{
					dataType="Object";
					class PositionInfo
					{
						position[]={9954.3701,12.264382,12033.22};
					};
					side="West";
					flags=5;
					class Attributes
					{
						skill=0.40000001;
					};
					id=3;
					type="B_Soldier_GL_F";
				};
				class Item3
				{
					dataType="Object";
					class PositionInfo
					{
						position[]={9969.3701,11.989189,12028.22};
					};
					side="West";
					flags=5;
					class Attributes
					{
						skill=0.40000001;
					};
					id=4;
					type="B_soldier_LAT_F";
				};
			};
			class Attributes
			{
			};
			id=0;
		};
		class Item1
		{
			dataType="Group";
			side="East";
			class Entities
			{
				items=4;
				class Item0
				{
					dataType="Object";
					class PositionInfo
					{
						position[]={9962.2861,12.324856,12202.177};
						angles[]={0,3.1687291,-0};
					};
					side="East";
					flags=7;
					class Attributes
					{
						rank="SERGEANT";
					};
					id=6;
					type="O_Soldier_TL_F";
				};
				class Item1
				{
					dataType="Object";
					class PositionInfo
					{
						position[]={9957.4238,12.757553,12207.311};
						angles[]={0,3.1687291,-0};
					};
					side="East";
					flags=5;
					class Attributes
					{
						skill=0.44999999;
						rank="CORPORAL";
					};
					id=7;
					type="O_Soldier_AR_F";
				};
				class Item2
				{
					dataType="Object";
					class PositionInfo
					{
						position[]={9967.4199,12.104147,12207.039};
						angles[]={0,3.1687291,-0};
					};
					side="East";
					flags=5;
					class Attributes
					{
						skill=0.40000001;
					};
					id=8;
					type="O_Soldier_GL_F";
				};
				class Item3
				{
					dataType="Object";
					class PositionInfo
					{
						position[]={9952.5615,13.112259,12212.444};
						angles[]={0,3.1687291,-0};
					};
					side="East";
					flags=5;
					class Attributes
					{
						skill=0.40000001;
					};
					id=9;
					type="O_Soldier_LAT_F";
				};
			};
			class Attributes
			{
			};
			id=5;
		};`;
}

/**
 * Multiplayer variant: same two fire teams, but the OPFOR team leader is playable and carries
 * a speaker/pitch attribute so the MP lobby shows a proper slot.
 */
function missionEntitiesMultiplayer(): string {
    return `		class Item0
		{
			dataType="Group";
			side="West";
			class Entities
			{
				items=4;
				class Item0
				{
					dataType="Object";
					class PositionInfo
					{
						position[]={9959.3701,11.814472,12038.22};
					};
					side="West";
					flags=7;
					class Attributes
					{
						rank="SERGEANT";
						isPlayer=1;
					};
					id=1;
					type="B_Soldier_TL_F";
				};
				class Item1
				{
					dataType="Object";
					class PositionInfo
					{
						position[]={9964.3701,11.917388,12033.22};
					};
					side="West";
					flags=5;
					class Attributes
					{
						skill=0.44999999;
						rank="CORPORAL";
					};
					id=2;
					type="B_soldier_AR_F";
				};
				class Item2
				{
					dataType="Object";
					class PositionInfo
					{
						position[]={9954.3701,12.264382,12033.22};
					};
					side="West";
					flags=5;
					class Attributes
					{
						skill=0.40000001;
					};
					id=3;
					type="B_Soldier_GL_F";
				};
				class Item3
				{
					dataType="Object";
					class PositionInfo
					{
						position[]={9969.3701,11.989189,12028.22};
					};
					side="West";
					flags=5;
					class Attributes
					{
						skill=0.40000001;
					};
					id=4;
					type="B_soldier_LAT_F";
				};
			};
			class Attributes
			{
			};
			id=0;
		};
		class Item1
		{
			dataType="Group";
			side="East";
			class Entities
			{
				items=4;
				class Item0
				{
					dataType="Object";
					class PositionInfo
					{
						position[]={9962.2861,12.324855,12202.177};
						angles[]={0,3.1687324,0};
					};
					side="East";
					flags=7;
					class Attributes
					{
						rank="SERGEANT";
						isPlayable=1;
					};
					id=6;
					type="O_Soldier_TL_F";
					atlOffset=-9.5367432e-07;
					class CustomAttributes
					{
						class Attribute0
						{
							property="speaker";
							expression="_this setspeaker _value;";
							class Value
							{
								class data
								{
									singleType="STRING";
									value="Male01PER";
								};
							};
						};
						class Attribute1
						{
							property="pitch";
							expression="_this setpitch _value;";
							class Value
							{
								class data
								{
									singleType="SCALAR";
									value=1.01;
								};
							};
						};
						nAttributes=2;
					};
				};
				class Item1
				{
					dataType="Object";
					class PositionInfo
					{
						position[]={9957.4238,12.757553,12207.311};
						angles[]={0,3.1687291,-0};
					};
					side="East";
					flags=5;
					class Attributes
					{
						skill=0.44999999;
						rank="CORPORAL";
					};
					id=7;
					type="O_Soldier_AR_F";
				};
				class Item2
				{
					dataType="Object";
					class PositionInfo
					{
						position[]={9967.4199,12.104147,12207.039};
						angles[]={0,3.1687291,-0};
					};
					side="East";
					flags=5;
					class Attributes
					{
						skill=0.40000001;
					};
					id=8;
					type="O_Soldier_GL_F";
				};
				class Item3
				{
					dataType="Object";
					class PositionInfo
					{
						position[]={9952.5615,13.112259,12212.444};
						angles[]={0,3.1687291,-0};
					};
					side="East";
					flags=5;
					class Attributes
					{
						skill=0.40000001;
					};
					id=9;
					type="O_Soldier_LAT_F";
				};
			};
			class Attributes
			{
			};
			id=5;
			atlOffset=-9.5367432e-07;
		};`;
}
function descriptionExt(multiplayer: boolean): string {
    return `class Header {
    gameType = "Coop";
    minPlayers = 1;
    maxPlayers = ${multiplayer ? 8 : 1};
    playerCount = 1;
    author = "Arma 3 SQF Reloader";
    onLoadName = "Example counter";
    onLoadMission = "Minimal mission that runs the example mod functions.";
};

// Permit SqfReloader to replace CfgFunctions entries while this mission is open.
allowFunctionsRecompile = 1;

class CfgFunctions {
    class ExampleMission {
        tag = "ExampleMission";
        class Tests {
            file = "functions";
            class liveTest {};
        };
    };
};

// SqfReloader_fnc_runStartup runs this once the mod's Cfg3DEN init started the REST API
// (or when the VS Code launcher starts the mission).
class SqfReloader {
    StartupCode = "diag_log '[ExampleMod] SqfReloader startup code ran';";
};
`;
}

function missionInitPlayerLocal(): string {
    return `// Runs in the playable mission after Eden has switched missionNamespace.
// Register the workspace functions again for this mission instance.
${startupScript()}

if (!hasInterface) exitWith {};

[] spawn {
    sleep 2;
    [] call ${TEMPLATE_TAG}_fnc_showCounter;
    [] call ExampleMission_fnc_liveTest;
};
`;
}

function missionLiveTest(): string {
    return `// Mission-local CfgFunctions hot-reload test.
// Edit this message, save, then call [] call ExampleMission_fnc_liveTest; again.
private _message = "Mission function v1 - edit and save fn_liveTest.sqf";
systemChat _message;
_message
`;
}

function vscodeSettings(): string {
    return `{
    // Set this when Arma 3 is not detected automatically (folder with arma3_x64.exe).
    "sqfReloader.armaDirectory": "",
    // Set a profile name to choose it; leave empty to use the most recently updated profile.
    "sqfReloader.armaProfile": "",
    // Remove Arma-generated ~Mission.World preview folders from the active profile.
    "sqfReloader.clearArmaMissionArtifacts": true,
    "sqfReloader.junctionMode": "addon",
    "sqfReloader.reloadOnSave": "reload",
    "sqfReloader.extraLaunchArguments": "-noSplash -skipIntro -noPause -showScriptErrors -window"
}
`;
}
