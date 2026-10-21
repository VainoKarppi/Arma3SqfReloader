import { Socket } from "net";

export const DEFAULT_PORT = 8764;
export const DEFAULT_HOST = "127.0.0.1";

/**
 * Highest port probed after the configured one. Searching upwards first means a busy 8764
 * (EdenOnline, an older SqfReloader build, a docs server) only costs a few numbers.
 */
const HIGHEST_PORT = DEFAULT_PORT + 40;

/**
 * True when nothing listens on host:port, so the DLL can bind an HttpListener there.
 *
 * ECONNREFUSED is the expected answer on a free port. Windows registers HttpListener prefixes
 * per port for both loopback families, so a port whose IPv4 side is free can still be taken.
 */
export function isPortFree(port: number, host: string = DEFAULT_HOST): Promise<boolean> {
    return new Promise(resolve => {
        const socket = new Socket();
        let settled = false;

        const finish = (free: boolean): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(free);
        };

        socket.setTimeout(250);
        socket.once("timeout", () => finish(true));
        socket.once("error", (error: NodeJS.ErrnoException) => {
            finish(error.code === "ECONNREFUSED" || error.code === "ENETUNREACH" || error.code === "EHOSTUNREACH");
        });
        socket.once("connect", () => finish(false));

        try {
            socket.connect({ port, host });
        } catch {
            finish(true);
        }
    });
}

/** Ports to probe, in preference order: the configured port, then its neighbours. */
export function candidatePorts(configuredPort: number = DEFAULT_PORT): number[] {
    const preferred = Math.min(Math.max(configuredPort, 1), 65535);
    const ports = [preferred];

    // 8764 is a very common tool port; probing the neighbours first keeps the search short.
    for (let step = 1; step <= 8; step++) {
        if (preferred - step >= 1024) ports.push(preferred - step);
        if (preferred + step <= 65535) ports.push(preferred + step);
    }

    for (let port = preferred + 9; port <= Math.min(HIGHEST_PORT, 65535); port++) {
        ports.push(port);
    }

    return [...new Set(ports)];
}

/** First free port among {@link candidatePorts}, falling back to the configured one. */
export async function findFreePort(configuredPort: number = DEFAULT_PORT, host: string = DEFAULT_HOST): Promise<number> {
    const ports = candidatePorts(configuredPort);
    const results = await Promise.all(ports.map(port => isPortFree(port, host)));
    const index = results.indexOf(true);

    return index >= 0 ? ports[index] : configuredPort;
}

/** Extracts host and port from a URL such as http://127.0.0.1:8764/api. */
export function parseApiUrl(apiUrl: string): { host: string; port: number } {
    try {
        const url = new URL(apiUrl);
        return {
            host: url.hostname || DEFAULT_HOST,
            port: url.port ? Number(url.port) : DEFAULT_PORT
        };
    } catch {
        return { host: DEFAULT_HOST, port: DEFAULT_PORT };
    }
}
