import * as path from "path";
import { pathToFileURL } from "url";
import { MissionFolder } from "./arma";
import { projectSetting } from "./projectSettings";
import { Settings } from "./settings";
import { PreparedLaunch } from "./runtime";

/**
 * Arma command line: option parsing and the argument list handed to arma3_x64.exe /
 * arma3server_x64.exe. Kept out of launcher.ts so the process, RPT and Steam handling there can
 * be read without scrolling through quoting rules.
 */

export interface LaunchOptions {
    /** Extra launch parameters, e.g. "-window -noSplash". */
    extraArguments?: string[];
    /** Existing game mission launch arguments, if any. */
    mission?: string;
    /** Absolute mission.sqm path; Arma opens this scenario directly in Eden at startup. */
    scenarioFile?: string;
    /** Mission to ensure is linked into the selected profile's Missions/MPMissions folder. */
    missionFolder?: MissionFolder;
    /** Host the selected mission in a listen-server session. */
    hostMission?: boolean;
    /** Start arma3server_x64.exe with the selected server config and mission. */
    dedicatedServer?: boolean;
    serverConfig?: string;
    /** Extra mod roots to include in the Arma launch (for generated server examples). */
    additionalModDirectories?: string[];
    /** Show the exact dedicated-server command and ask before starting. */
    confirmLaunch?: boolean;
}

export function formatLaunchArgument(argument: string): string[] {
    const unwrapped = argument.startsWith('"') && argument.endsWith('"')
        ? argument.slice(1, -1)
        : argument;
    const modMatch = /^(-(?:server)?mod)=(.*)$/i.exec(unwrapped);
    if (modMatch) {
        return [
            `${modMatch[1]}=`,
            ...modMatch[2].split(";").map(directory => `\t\t${pathToFileURL(directory).href}`)
        ];
    }

    const profileMatch = /^(-name)=(.*)$/i.exec(argument);
    if (profileMatch) {
        const name = profileMatch[2].startsWith('"') && profileMatch[2].endsWith('"')
            ? profileMatch[2]
            : `"${profileMatch[2]}"`;
        return [`${profileMatch[1]}=${name}`];
    }

    return [argument];
}

export function launchArguments(launch: PreparedLaunch, settings: Settings, options: LaunchOptions): string[] {
    // File patching is required twice: user mods are junctions to the working copy, and
    // @SqfReloader's replacement config must override the config inside scripts.pbo.
    const args: string[] = ["-filePatching"];

    if (options.dedicatedServer) {
        args.push("-autoInit");
    }

    if (options.hostMission) {
        args.push("-host");
    }

    if (options.dedicatedServer && options.serverConfig) {
        const config = options.serverConfig.replace(/"/g, "\\\"");
        args.push(`-config="${config}"`);
    }

    const serverExtraArguments = options.dedicatedServer
        ? parseLaunchArguments(projectSetting("serverLaunchArguments", ""))
        : [];
    const extra = [...(options.extraArguments ?? parseLaunchArguments(settings.extraLaunchArguments)), ...serverExtraArguments];
    const launchExtras = settings.armaProfile?.trim() ? withoutProfileName(extra) : extra;

    // BattlEye cannot load unsigned extensions, so it is off unless the user asks for it.
    if (!launchExtras.some(argument => /^-(no)?be$/i.test(argument))) {
        args.push("-noBattlEye");
    }

    if (launchExtras.length > 0) {
        args.push(...launchExtras);
    }

    // When profile auto-detection picked a named profile, explicitly launch that same profile.
    // Otherwise Arma would default to Documents\Arma 3 while the mission junction targets the
    // detected Documents\Arma 3 - Other Profiles\<name> folder.
    if (launch.profile.launchName && !launchExtras.some(argument => /^-name(?:=|$)/i.test(argument))) {
        const profileName = launch.profile.launchName.replace(/"/g, "\\\"");
        args.push(/\s/.test(profileName) ? `-name="${profileName}"` : `-name=${profileName}`);
    }

    // Arma parses a bare mission.sqm argument as the editor startup scenario. Keep it after
    // profile and gameplay options, matching the working launcher command line; add its
    // memory-load switch after the path, then put -mod last as in the known-good invocation.
    if (options.scenarioFile) {
        const scenarioFile = options.scenarioFile.replace(/"/g, "\\\"");
        args.push(/\s/.test(scenarioFile) ? `"${scenarioFile}"` : scenarioFile);
        args.push("-loadMissionToMemory");
    }

    if (options.hostMission && options.missionFolder) {
        args.push(`-mission=${path.basename(options.missionFolder.directory)}.pbo`);
    }

    // Arma expects the whole -mod value quoted as one argument, with semicolons separating
    // paths inside it. Quoting each path separately makes Arma ignore the startup scenario.
    const mods = launch.mods;
    if (mods.length > 0) {
        args.push(`"-mod=${mods.map(uppercaseDriveLetter).join(";")}"`);
    }

    const serverMods = launch.serverMods;
    if (options.dedicatedServer && serverMods.length > 0) {
        args.push(`"-serverMod=${serverMods.map(uppercaseDriveLetter).join(";")}"`);
    }

    if (options.mission) {
        args.push(`-mission=${options.mission}`);
    }

    return args;
}

/** Arma reads drive letters case-sensitively in some paths; keep them upper case. */
export function uppercaseDriveLetter(value: string): string {
    return value.replace(/^([a-z]):/i, (_match, drive: string) => `${drive.toUpperCase()}:`);
}

/** Drops -name options so the detected profile name is not duplicated. */
export function withoutProfileName(argumentsList: string[]): string[] {
    const result: string[] = [];
    for (let index = 0; index < argumentsList.length; index++) {
        const argument = argumentsList[index];
        if (/^-name$/i.test(argument)) {
            if (index + 1 < argumentsList.length) index++;
            continue;
        }
        if (/^-name=/i.test(argument)) continue;
        result.push(argument);
    }
    return result;
}

/** Splits a settings string into arguments, keeping quoted values together. */
export function parseLaunchArguments(value: string): string[] {
    const argumentsList: string[] = [];
    let current = "";
    let quote: "\"" | "'" | undefined;

    for (const character of value) {
        if (quote) {
            current += character;
            if (character === quote) quote = undefined;
        } else if (character === "\"" || character === "'") {
            quote = character;
            current += character;
        } else if (/\s/.test(character)) {
            if (current) argumentsList.push(current);
            current = "";
        } else {
            current += character;
        }
    }

    if (current) argumentsList.push(current);
    return argumentsList;
}
