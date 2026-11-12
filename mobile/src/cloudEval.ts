// Lichess cloud evaluations: when Lichess already has a (usually much deeper)
// evaluation of a position, the phone shows it instead of running Stockfish.
// Kept only in memory while the app is open.

import type { Analysis, EngineLine } from "./engine";

const URL_BASE = "https://lichess.org/api/cloud-eval";
export const CLOUD_LINES = 3;
/** After a refusal for too many requests, Lichess is left alone for this long. */
const PAUSE_MS = 60_000;

type CloudPv = { moves: string; cp?: number; mate?: number };
type CloudResponse = { fen: string; depth: number; knodes?: number; pvs: CloudPv[] };

export type CloudAnalysis = Analysis & { source: "lichess" };

const cache = new Map<string, CloudAnalysis | null>();
let pausedUntil = 0;

/** Position without move counters: the same position reached in another way. */
function positionKey(fen: string) {
    return fen.split(" ").slice(0, 4).join(" ");
}

/** Converts Lichess's answer (scores from White's point of view) to the engine's format. */
export function fromCloud(fen: string, data: CloudResponse): CloudAnalysis | null {
    const lines: EngineLine[] = data.pvs
        .filter((pv) => pv.moves)
        .map((pv, i) => ({
            multipv: i + 1,
            depth: data.depth,
            score:
                pv.mate !== undefined
                    ? { type: "mate" as const, value: pv.mate }
                    : { type: "cp" as const, value: pv.cp ?? 0 },
            pv: pv.moves.split(" "),
        }));
    if (!lines.length) return null;
    return { fen, depth: data.depth, lines, done: true, source: "lichess" };
}

/**
 * Lichess's evaluation of `fen` (up to 3 lines), or null when Lichess does not have it
 * or cannot be reached (then the phone's engine does the work).
 */
export async function cloudEval(
    fen: string,
    token: string,
    fetchImpl: typeof fetch = fetch,
): Promise<CloudAnalysis | null> {
    const key = positionKey(fen);
    const known = cache.get(key);
    if (known !== undefined) return known && { ...known, fen };
    if (Date.now() < pausedUntil) return null;
    const params = new URLSearchParams({ fen, multiPv: String(CLOUD_LINES) });
    let res: Response;
    try {
        res = await fetchImpl(`${URL_BASE}?${params}`, {
            headers: token.trim() ? { Authorization: `Bearer ${token.trim()}` } : {},
        });
    } catch {
        return null; // offline: not remembered, it may work later
    }
    if (res.status === 404) {
        cache.set(key, null);
        return null;
    }
    if (res.status === 429) {
        pausedUntil = Date.now() + PAUSE_MS;
        return null;
    }
    if (res.status === 401 && token.trim()) {
        // A token Lichess does not accept: the cloud works without one too.
        return cloudEval(fen, "", fetchImpl);
    }
    if (!res.ok) return null;
    try {
        const result = fromCloud(fen, (await res.json()) as CloudResponse);
        cache.set(key, result);
        return result;
    } catch {
        return null;
    }
}

/** For tests. */
export function resetCloudCache() {
    cache.clear();
    pausedUntil = 0;
}
