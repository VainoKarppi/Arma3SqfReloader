import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { findMods, Mod } from "./arma";
import { log, readSettings } from "./settings";
import { PROJECT_SETTINGS_FILE } from "./projectSettings";
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
    /** Server mod/config/mission example directory. */
    serverExampleDirectory?: string;
}

/**
 * Creates the example mod, missions, and dedicated-server files in the open workspace.
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

    return result;
}

/**
 * Writes the template without touching the VS Code UI (also used by scripts/verify-template.js).
 * Existing files are only overwritten with force=true.
 */
export function writeTemplate(root: string, withMission: boolean, force: boolean): ScaffoldResult {
    const modDirectory = path.join(root, TEMPLATE_MOD_NAME);
    const addonDirectory = path.join(modDirectory, "addons", "scripts");
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

    // The directory name under addons is scripts; the CfgFunctions tag remains "example".
    write(path.join(addonDirectory, "functions", "fn_hello.sqf"), fnHello());
    write(path.join(addonDirectory, "functions", "fn_add.sqf"), fnAdd());
    write(path.join(addonDirectory, "functions", "fn_showCounter.sqf"), fnShowCounter());

    // The project settings file belongs to the user once it exists: recreating the template must
    // never reset launch options or mod roles that were configured in the project settings panel.
    const settingsFile = path.join(root, ".vscode", PROJECT_SETTINGS_FILE);
    if (fs.existsSync(settingsFile)) {
        skipped.push(settingsFile);
    } else {
        write(settingsFile, projectSettingsTemplate());
    }

    let missionDirectory: string | undefined;
    let mpMissionDirectory: string | undefined;
    const serverExampleDirectory = writeServerExample(root, write);

    if (withMission) {
        missionDirectory = writeMission(path.join(root, "missions", `${TEMPLATE_TAG}.Altis`), write, false);
        mpMissionDirectory = writeMission(path.join(root, "mpmissions", `${TEMPLATE_TAG}.Altis`), write, true);
    }

    return { modDirectory, files, skipped, missionDirectory, mpMissionDirectory, serverExampleDirectory };
}

function writeServerExample(root: string, write: (file: string, content: string) => void): string {
    const directory = path.join(root, "server-example");
    const addonDirectory = path.join(directory, "@ExampleServerMod", "addons", "server");

    write(path.join(directory, "server.cfg"), serverConfig());
    write(path.join(directory, "README.md"), serverReadme());
    write(path.join(addonDirectory, "config.cpp"), serverModConfig());
    write(path.join(addonDirectory, "functions", "fn_serverMessage.sqf"), serverMessageFunction());
    write(path.join(addonDirectory, "functions", "fn_receiveReloadedFunction.sqf"), receiveReloadedFunction());
    write(path.join(directory, "ExampleMission.Altis", "description.ext"), serverMissionDescription());
    write(path.join(directory, "ExampleMission.Altis", "init.sqf"), serverMissionInitScript());
    write(path.join(directory, "ExampleMission.Altis", "initServer.sqf"), serverMissionInit());
    write(path.join(directory, "ExampleMission.Altis", "initPlayerLocal.sqf"), serverMissionPlayerInit());
    write(path.join(directory, "ExampleMission.Altis", "functions", "fn_preInit.sqf"), serverPreInitFunction());
    write(path.join(directory, "ExampleMission.Altis", "functions", "fn_postInit.sqf"), serverPostInitFunction());
    write(path.join(directory, "ExampleMission.Altis", "functions", "fn_serverMissionInit.sqf"), serverMissionInitFunction());
    write(path.join(directory, "ExampleMission.Altis", "functions", "fn_broadcastInitMessage.sqf"), generatedMissionBroadcastInitMessage());
    write(path.join(directory, "ExampleMission.Altis", "CfgRemoteExec.hpp"), serverRemoteExecConfig());
    write(path.join(directory, "ExampleMission.Altis", "mission.sqm"), serverMissionSqm());

    return directory;
}

function serverConfig(): string {
    return `hostname = "SqfReloader Development Server";
password = "";
passwordAdmin = "change-this-password";
maxPlayers = 16;
verifySignatures = 0;
BattlEye = 0;
persistent = 1;

class Missions {
    class ExampleMissionAltis {
        template = "ExampleMission.Altis";
        difficulty = "Regular";
    };
};
`;
}

function serverReadme(): string {
    return `# Dedicated server example

This folder contains a local Arma 3 dedicated-server example, a live-reloadable server addon,
and a multiplayer mission. Change \`passwordAdmin\` in \`server.cfg\` before exposing a server.

Use **SqfReloader: Play** for client/listen-server live reload from this workspace. To start a
dedicated server, right-click \`server.cfg\` and choose **SqfReloader: Start dedicated server
(server.cfg)**. The workspace classifies \`@ExampleServerMod\` as server-only, so it is loaded
through \`-serverMod\` instead of the regular \`-mod\` parameter.
Live SQF reload through the local REST API is for a local Arma process; it does not attach a
remote dedicated server.

The server function changes and multiplayer mission changes are broadcast using remoteExec.
The mission's \`CfgRemoteExec.hpp\` explicitly permits
\`SqfReloader_fnc_receiveReloadedFunction\` for clients. The mission includes
\`init.sqf\`, \`initServer.sqf\`, \`initPlayerLocal.sqf\`, and CfgFunctions preInit/postInit
functions so you can observe which initialization context runs each script.
`;
}

function serverModConfig(): string {
    return `class CfgPatches {
    class ExampleServer {
        name = "Example Server Functions";
        author = "SqfReloader";
        requiredVersion = 2.10;
        requiredAddons[] = {};
        units[] = {};
        weapons[] = {};
    };
};

class CfgFunctions {
    class Example {
        tag = "Example";
        class Scripts {
            file = "\\Example\\addons\\server\\functions";
            class serverMessage {};
            class receiveReloadedFunction {};
            class broadcastInitMessage {};
        };
    };
};
#include "CfgRemoteExec.hpp"
`;
}

function serverMessageFunction(): string {
    return `params [["_message", "Hello from the dedicated server", [""]]];
if (!isServer) exitWith {};

[_message] remoteExec ["systemChat", 0];
`;
}

function receiveReloadedFunction(): string {
    return `params [
    ["_name", "", [""]],
    ["_function", {}, [{}]]
];

if (_name isEqualTo "" || {!(_function isEqualType {})}) exitWith {};
missionNamespace setVariable [_name, _function];
diag_log format ["[ExampleServerMod] received reloaded function %1 from server", _name];
`;
}

function serverMissionDescription(): string {
    return `allowFunctionsRecompile = 1;

class Header {
    gameType = "Coop";
    minPlayers = 1;
    maxPlayers = 16;
};

class CfgFunctions {
    class ExampleMission {
        tag = "ExampleMission";
        class Init {
            file = "functions";
            class preInit { preInit = 1; };
            class postInit { postInit = 1; };
            class serverMissionInit {};
        };
    };
};
#include "CfgRemoteExec.hpp"
`;
}

function serverRemoteExecConfig(): string {
    return `class CfgRemoteExec {
    class Functions {
        mode = 1;
        jip = 0;
        class Example_fnc_serverMessage {
            allowedTargets = 2;
        };
        class SqfReloader_fnc_receiveReloadedFunction {
            allowedTargets = 2;
        };
        class ExampleMission_fnc_broadcastInitMessage {
            allowedTargets = 1;
        };
    };
};
`;
}

function serverMissionSqm(): string {
    return `version=54;
class EditorData
{
    moveGridStep=1;
    angleGridStep=1;
    scaleGridStep=1;
    autoGrouping=0;
    toggles=1;
    class ItemIDProvider { nextID=1; };
    class MarkerIDProvider { nextID=0; };
    class LayerIndexProvider { nextID=1; };
    class Camera
    {
        pos[]={0,1000,0};
        dir[]={0,-1,0};
        up[]={0,0,1};
        aside[]={1,0,0};
    };
};
class ScenarioData
{
    author="SqfReloader";
    overview="Development mission for the server-mod example.";
};
class Mission
{
    class Intel
    {
        briefingName="SqfReloader Server Mod Example";
        startWeather=0.2;
        startWind=0.1;
        startWaves=0.1;
        forecastWeather=0.2;
        forecastWind=0.1;
        forecastWaves=0.1;
        year=2035;
        month=6;
        day=24;
        hour=12;
        minute=0;
    };
    class Entities
    {
        items=0;
    };
};
`;
}

function serverMissionInit(): string {
    return `diag_log "[ExampleMission] initServer.sqf ran";
["initServer.sqf ran"] remoteExec ["systemChat", 0];
`;
}

function serverMissionInitScript(): string {
    return `diag_log "[ExampleMission] init.sqf ran";
["init.sqf ran"] remoteExec ["systemChat", 0];
`;
}

function serverMissionPlayerInit(): string {
    return `if (!hasInterface) exitWith {};

systemChat format ["initPlayerLocal.sqf: hello %1", profileName];
`;
}

function serverPreInitFunction(): string {
    return `if (!isServer) exitWith {};
diag_log "[ExampleMission] CfgFunctions preInit ran";
missionNamespace setVariable ["ExampleMission_preInitRan", true];
`;
}

function serverPostInitFunction(): string {
    return `if (!isServer) exitWith {};
diag_log "[ExampleMission] CfgFunctions postInit ran";
missionNamespace setVariable ["ExampleMission_postInitRan", true];

[] spawn {
	while {true} do {
		diag_log "preInitLoopTest";
		sleep 5;
	};
};
`;
}

function serverMissionInitFunction(): string {
    return `if (!isServer) exitWith {};
diag_log "[ExampleMission] ExampleMission_fnc_serverMissionInit ran";
["CfgFunctions server init ran"] remoteExec ["systemChat", 0];
`;
}

/**
 * Writes one test mission: a mission.sqm (Eden needs it), description.ext and the init script.
 * The multiplayer copy gets the MP header keys, so it shows up in the host/join lists.
 */
function writeMission(directory: string, write: (file: string, content: string) => void, multiplayer: boolean): string {
    write(path.join(directory, "mission.sqm"), missionSqm(multiplayer));
    write(path.join(directory, "description.ext"), descriptionExt(multiplayer));
    write(path.join(directory, "functions", "fn_liveTest.sqf"), missionLiveTest());
    writeMissionInitializationScripts(directory, write, multiplayer);

    return directory;
}

function writeMissionInitializationScripts(
    directory: string,
    write: (file: string, content: string) => void,
    multiplayer: boolean
): void {
    write(path.join(directory, "init.sqf"), generatedMissionInit(multiplayer));
    write(path.join(directory, "initServer.sqf"), generatedMissionServerInit(multiplayer));
    write(path.join(directory, "initPlayerLocal.sqf"), generatedMissionPlayerInit(multiplayer));
    write(path.join(directory, "initPlayerServer.sqf"), generatedMissionPlayerServerInit());
    write(path.join(directory, "initRespawn.sqf"), generatedMissionRespawnInit());
    write(path.join(directory, "OnPlayerKilled.sqf"), generatedOnPlayerKilled());
    write(path.join(directory, "OnPlayerRespawn.sqf"), generatedOnPlayerRespawn());
    write(path.join(directory, "functions", "fn_preInit.sqf"), generatedMissionPreInit(multiplayer));
    write(path.join(directory, "functions", "fn_postInit.sqf"), generatedMissionPostInit(multiplayer));
    if (multiplayer) write(path.join(directory, "functions", "fn_broadcastInitMessage.sqf"), generatedMissionBroadcastInitMessage());
    if (multiplayer) {
        write(path.join(directory, "functions", "fn_receiveReloadedFunction.sqf"), receiveReloadedFunction());
        write(path.join(directory, "CfgRemoteExec.hpp"), missionRemoteExecConfig());
    }
}

/** The generated example mod, when it exists in the workspace. */
export function exampleMod(root: string): Mod | undefined {
    return findMods(root).find(mod => mod.name.toLowerCase() === TEMPLATE_MOD_NAME.toLowerCase());
}

async function askForMission(): Promise<boolean> {
    const choice = await vscode.window.showQuickPick(
        [
            { label: "Mod + test mission", description: "Also writes missions\\example.Altis and mpmissions\\example.Altis, which call the functions on spawn.", value: true },
            { label: "Mod only", description: "Use the example functions in your own mission.", value: false }
        ],
        { title: "Arma 3 SQF Reloader: example mod", ignoreFocusOut: true }
    );

    return choice?.value ?? true;
}

/** Opens the two files a developer edits first. */
async function revealExample(result: ScaffoldResult): Promise<void> {
    const hello = result.files.find(file => file.endsWith("fn_hello.sqf"));
    const config = result.files.find(file => file.endsWith("config.cpp") && file.includes(`${TEMPLATE_MOD_NAME}${path.sep}addons${path.sep}`));

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

        if (result.serverExampleDirectory) {
            try {
                const document = await vscode.workspace.openTextDocument(
                    vscode.Uri.file(path.join(result.serverExampleDirectory, "README.md"))
                );
                await vscode.window.showTextDocument(document, { preview: false });
            } catch (error) {
                log(`Could not open server example README: ${error instanceof Error ? error.message : String(error)}`);
            }
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

            class hello {};
            class add {};
            class showCounter {};
        };
    };
};

class Cfg3DEN {
    class EventHandlers {
        class ${TEMPLATE_TAG} {
			init = "diag_log 'SQFR: 3DEN init';";
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
 * (`isPlayable=1`) with a speaker/pitch custom attribute and adds a BLUFOR respawn marker.
 */
function missionSqm(multiplayer: boolean): string {
    const missionEntities = multiplayer ? missionEntitiesMultiplayer() : missionEntitiesSingleplayer();
    const entities = multiplayer ? `${missionEntities}
${missionRespawnMarker()}` : missionEntities;

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
		items=${multiplayer ? 3 : 2};
${entities}
	};
};
`;
}

function missionRespawnMarker(): string {
    return `		class Item2
		{
			dataType="Marker";
			position[]={9959.3701,12,12038.22};
			name="respawn_west";
			text="BLUFOR Respawn";
			type="mil_start";
			colorName="ColorWEST";
			id=10;
		};`;
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
    const playerCount = multiplayer ? 8 : 1;
    return `class Header {
    gameType = "Coop";
    minPlayers = 1;
    maxPlayers = ${playerCount};
    playerCount = 1;
    author = "Arma 3 SQF Reloader";
    onLoadName = "Example counter";
    onLoadMission = "Minimal mission that runs the example mod functions.";
};

${multiplayer ? "respawn = 3;" : "respawn = 0;"}
respawnDelay = 5;
respawnOnStart = 0;
respawnTemplates[] = {"MenuPosition"};

// Permit SqfReloader to replace CfgFunctions entries while this mission is open.
allowFunctionsRecompile = 1;

${multiplayer ? '#include "CfgRemoteExec.hpp"' : ""}

class CfgFunctions {
    class ExampleMission {
        tag = "ExampleMission";
        class Tests {
            file = "functions";
            class liveTest {};
            class preInit { preInit = 1; };
            class postInit { postInit = 1; };
            ${multiplayer ? "class broadcastInitMessage {};" : ""}
            ${multiplayer ? "class receiveReloadedFunction {};" : ""}
        };
    };
    ${multiplayer ? `    class ExampleMissionServer {
        tag = "ExampleMission";
        class Server {
            file = "functions";
            class receiveReloadedFunction {};
        };
    };` : ""}
};
`;
}

function missionRemoteExecConfig(): string {
    return `class CfgRemoteExec {
    class Functions {
        mode = 1;
        jip = 0;
        class SqfReloader_fnc_receiveReloadedFunction {
            allowedTargets = 0;
        };
        class ExampleMission_fnc_broadcastInitMessage {
            allowedTargets = 1;
        };
    };
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

function generatedMissionInit(multiplayer: boolean): string {
    const context = multiplayer ? "MP mission" : "single-player mission";
    return `diag_log "[ExampleMission] init.sqf ran (${context})";
systemChat "ExampleMission init.sqf ran";
`;
}

function generatedMissionServerInit(multiplayer: boolean): string {
    return `if (!isServer) exitWith {};
diag_log "[ExampleMission] initServer.sqf ran (${multiplayer ? "MP" : "single-player"})";
missionNamespace setVariable ["ExampleMission_serverInitRan", true];
`;
}

function generatedMissionPlayerInit(multiplayer: boolean): string {
    const startup = multiplayer ? `${startupScript()}\n` : "";
    return `if (!hasInterface) exitWith {};
${startup}
diag_log format ["[ExampleMission] initPlayerLocal.sqf ran for %1", profileName];
systemChat format ["ExampleMission initPlayerLocal.sqf ran for %1", profileName];
${multiplayer ? '["initPlayerLocal.sqf player ready"] remoteExec ["ExampleMission_fnc_broadcastInitMessage", 2];' : "[] spawn { uiSleep 1; [] call ExampleMission_fnc_liveTest; };"}
`;
}

function generatedMissionBroadcastInitMessage(): string {
    return `params [["_message", "", [""]]];
if (!isServer) exitWith {};
diag_log format ["[ExampleMission] client init: %1", _message];
systemChat format ["Server received: %1", _message];
`;
}

function generatedMissionPreInit(multiplayer: boolean): string {
    return `if (${multiplayer ? "!isServer" : "hasInterface"}) exitWith {};
diag_log "[ExampleMission] CfgFunctions preInit ran (${multiplayer ? "MP server" : "SP"})";
missionNamespace setVariable ["ExampleMission_preInitRan", true];
`;
}

function generatedMissionPostInit(multiplayer: boolean): string {
    return `if (${multiplayer ? "!isServer" : "!hasInterface"}) exitWith {};
diag_log "[ExampleMission] CfgFunctions postInit ran (${multiplayer ? "MP server" : "SP client"})";
missionNamespace setVariable ["ExampleMission_postInitRan", true];

[] spawn {
	while {true} do {
		diag_log "preInitLoopTest";
		sleep 5;
	};
};
`;
}

function generatedMissionPlayerServerInit(): string {
    return `if (!isServer) exitWith {};
params ["_player", "_didJIP"];
diag_log format ["[ExampleMission] initPlayerServer.sqf ran for %1 (JIP=%2)", name _player, _didJIP];
`;
}

function generatedMissionRespawnInit(): string {
    return `params ["_unit", "_corpse"];
diag_log format ["[ExampleMission] initRespawn ran for %1", name _unit];
systemChat "ExampleMission respawn initialization ran";
`;
}

function generatedOnPlayerKilled(): string {
    return `params ["_unit", "_killer", "_instigator", "_useEffects"];
diag_log format ["[ExampleMission] OnPlayerKilled: %1 killed by %2", name _unit, if (isNull _killer) then {"unknown"} else {name _killer}];
systemChat "OnPlayerKilled.sqf ran";
`;
}

function generatedOnPlayerRespawn(): string {
    return `params ["_newUnit", "_oldUnit", "_respawn", "_respawnDelay"];
diag_log format ["[ExampleMission] OnPlayerRespawn: %1 respawned", name _newUnit];
systemChat format ["OnPlayerRespawn.sqf ran for %1", name _newUnit];
`;
}

function projectSettingsTemplate(): string {
    return `{
    "armaProfile": "",
    "apiUrl": "http://127.0.0.1",
    "apiPort": 8764,
    "requestTimeout": 3000,
    "runTimeout": 30,
    "clearArmaMissionArtifacts": true,
    "enabled": true,
    "autoJunction": true,
    "junctionMode": "addon",
    "notifyOnError": true,
    "createExampleWithMission": true,
    "logLevel": "info",
    "reloadOnSave": "reload",
    "modTypes": {
		"@ExampleMod": "client",
        "server-example/@ExampleServerMod": "server"
    },
    "extraLaunchArguments": "-noSplash -skipIntro -noPause -showScriptErrors -window",
    "serverLaunchArguments": "",
    "watchInterval": 1000,
    "watchExpressions": [],
    "externalMods": [],
    "hooks": {},
    "hookPresentation": {
        "echo": true,
        "reveal": "always",
        "focus": false,
        "panel": "shared"
    }
}
`;
}
