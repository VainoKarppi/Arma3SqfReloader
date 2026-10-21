import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { findArmaDirectory } from "./arma";
import { documentsDirectory, selectArmaProfile } from "./profile";
import { log, Settings } from "./settings";

let scanTimer: ReturnType<typeof setInterval> | undefined;
let scanRoots: string[] = [];
let runningScan = false;

/** Monitor the selected profile's mission folders for Arma-generated Eden preview copies. */
export async function configureMissionArtifactCleanup(settings: Settings): Promise<void> {
    stopMissionArtifactCleanup();
    if (!settings.clearArmaMissionArtifacts) return;

    const armaDirectory = await findArmaDirectory(settings);
    if (!armaDirectory) {
        log("Mission artifact cleanup is enabled, but the Arma 3 installation could not be found yet.");
        return;
    }

    const profile = selectArmaProfile(armaDirectory, settings.extraLaunchArguments, settings.armaProfile);
    const docs = documentsDirectory();
    const profileDirectories = new Set<string>([
        profile.directory,
        path.join(docs, "Arma 3")
    ]);
    const otherProfiles = path.join(docs, "Arma 3 - Other Profiles");
    try {
        for (const entry of await fs.promises.readdir(otherProfiles, { withFileTypes: true })) {
            if (entry.isDirectory()) profileDirectories.add(path.join(otherProfiles, entry.name));
        }
    } catch {
        // The selected profile is still monitored if the standard profile directory is absent.
    }

    const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).flatMap(folder => [
        folder.uri.fsPath,
        path.join(folder.uri.fsPath, "missions"),
        path.join(folder.uri.fsPath, "mpmissions")
    ]);
    scanRoots = [...new Set([
        ...workspaceRoots,
        ...[...profileDirectories].flatMap(directory => [
            path.join(directory, "Missions"),
            path.join(directory, "MPMissions")
        ]),
        path.join(armaDirectory, "Missions"),
        path.join(armaDirectory, "MPMissions")
    ].map(directory => path.resolve(directory)))];
    log(`Monitoring Arma preview mission artifacts in ${scanRoots.join(" and ")}.`);

    void removeMissionArtifacts();
    // Keep this independent of Arma's close cleanup: preview artifacts are removed during
    // the session, while the existing close handler continues to clean SqfReloader snapshots.
    scanTimer = setInterval(() => void removeMissionArtifacts(), 500);
}

export function stopMissionArtifactCleanup(): void {
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = undefined;
    scanRoots = [];
}

async function removeMissionArtifacts(): Promise<void> {
    if (runningScan || scanRoots.length === 0) return;
    runningScan = true;

    try {
        for (const root of scanRoots) {
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(root, { withFileTypes: true });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    log(`Could not scan Arma mission folder ${root}: ${error instanceof Error ? error.message : String(error)}`);
                }
                continue;
            }

            for (const entry of entries) {
                if (!entry.isDirectory() || !/^~[^\\/:*?"<>|]+\.[^\\/:*?"<>|]+$/i.test(entry.name)) continue;

                const artifact = path.join(root, entry.name);
                try {
                    const stat = await fs.promises.lstat(artifact);
                    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;

                    const missionFile = path.join(artifact, "mission.sqm");
                    const missionStat = await fs.promises.lstat(missionFile);
                    if (!missionStat.isFile() || missionStat.isSymbolicLink()) continue;

                    await fs.promises.rm(artifact, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
                    log(`Removed Arma preview mission artifact: ${artifact}`);
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    if (code !== "ENOENT") {
                        log(`Could not remove Arma preview mission artifact ${artifact}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
            }
        }
    } finally {
        runningScan = false;
    }
}
