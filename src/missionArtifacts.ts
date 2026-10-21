import * as fs from "fs";
import * as path from "path";
import { findArmaDirectory } from "./arma";
import { selectArmaProfile } from "./profile";
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
    scanRoots = [path.join(profile.directory, "Missions"), path.join(profile.directory, "MPMissions")];
    log(`Monitoring Arma preview mission artifacts in ${scanRoots.join(" and ")}.`);

    void removeMissionArtifacts();
    scanTimer = setInterval(() => void removeMissionArtifacts(), 750);
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
                if (!entry.isDirectory() || !/^~[^\\/:*?"<>|]+\.[^\\/:*?"<>|]+$/.test(entry.name)) continue;

                const artifact = path.join(root, entry.name);
                try {
                    const stat = await fs.promises.lstat(artifact);
                    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;

                    const missionFile = path.join(artifact, "mission.sqm");
                    const missionStat = await fs.promises.lstat(missionFile);
                    if (!missionStat.isFile() || missionStat.isSymbolicLink()) continue;

                    // Arma marks its preview copy with a tilde sourceName. This extra check
                    // prevents deleting a developer's unrelated folder that happens to start
                    // with '~' and use a Mission.World-style name.
                    const header = await fs.promises.readFile(missionFile, "utf8");
                    if (!/\bsourceName\s*=\s*"~[^"]*"\s*;/i.test(header)) continue;

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
