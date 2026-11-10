import * as fs from "fs";
import * as path from "path";

export function armaLogDirectory(): string {
    const localAppData = process.env.LOCALAPPDATA?.trim() || path.join(require("os").homedir(), "AppData", "Local");
    return path.join(localAppData, "Arma 3");
}

export async function findLatestRptPath(): Promise<string> {
    let names: string[];
    try {
        names = await fs.promises.readdir(armaLogDirectory());
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
    }
    const files = await Promise.all(names
        .filter(name => /^arma3(?:server)?_x64_.*\.rpt$/i.test(name))
        .map(async name => {
            const file = path.join(armaLogDirectory(), name);
            try {
                const stats = await fs.promises.stat(file);
                return stats.isFile() ? { file, modified: stats.mtimeMs } : undefined;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
                throw error;
            }
        }));
    return files
        .filter((entry): entry is { file: string; modified: number } => !!entry)
        .sort((left, right) => right.modified - left.modified)[0]?.file ?? "";
}

export async function readRptTail(file: string): Promise<string> {
    const handle = await fs.promises.open(file, "r");
    try {
        const { size } = await handle.stat();
        const bytesToRead = Math.min(size, 64 * 1024);
        const buffer = Buffer.alloc(bytesToRead);
        await handle.read(buffer, 0, bytesToRead, size - bytesToRead);
        return buffer.toString("utf8").split(/\r?\n/).slice(-80).join("\n");
    } finally {
        await handle.close();
    }
}
