// Lichess opening explorer (masters database and Lichess games by rating/speed).
// Since 2026 Lichess requires a (free, scope-less) personal API token.

export type ExplorerDb = "masters" | "lichess";

export type ExplorerSettings = {
    token: string;
    /** Lichess rating buckets, e.g. [1600, 1800] = 1600-1999 */
    ratings: number[];
    speeds: string[];
};

export const RATING_BUCKETS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
export const SPEEDS: { id: string; name: string }[] = [
    { id: "bullet", name: "Bullet" },
    { id: "blitz", name: "Blitz" },
    { id: "rapid", name: "Rapid" },
    { id: "classical", name: "Classica" },
];

export const DEFAULT_EXPLORER: ExplorerSettings = {
    token: "",
    ratings: [1600, 1800],
    speeds: ["blitz", "rapid", "classical"],
};

export type ExplorerMove = {
    uci: string;
    san: string;
    white: number;
    draws: number;
    black: number;
    averageRating?: number;
};

export type ExplorerResult = {
    white: number;
    draws: number;
    black: number;
    moves: ExplorerMove[];
    opening: { eco: string; name: string } | null;
};

export class ExplorerError extends Error {
    constructor(
        message: string,
        readonly kind: "token" | "rate" | "network" | "other",
    ) {
        super(message);
    }
}

const BASE = "https://explorer.lichess.org";
const cache = new Map<string, ExplorerResult>();

export function explorerUrl(db: ExplorerDb, fen: string, settings: ExplorerSettings): string {
    const params = new URLSearchParams({ fen, moves: "12", topGames: "0" });
    if (db === "lichess") {
        params.set("variant", "standard");
        params.set("recentGames", "0");
        params.set(
            "speeds",
            (settings.speeds.length ? settings.speeds : DEFAULT_EXPLORER.speeds).join(","),
        );
        params.set(
            "ratings",
            (settings.ratings.length ? settings.ratings : DEFAULT_EXPLORER.ratings).join(","),
        );
    }
    return `${BASE}/${db}?${params}`;
}

export async function fetchExplorer(
    db: ExplorerDb,
    fen: string,
    settings: ExplorerSettings,
    fetchImpl: typeof fetch = fetch,
): Promise<ExplorerResult> {
    const url = explorerUrl(db, fen, settings);
    const cached = cache.get(url);
    if (cached) return cached;
    let res: Response;
    try {
        res = await fetchImpl(url, {
            headers: settings.token.trim()
                ? { Authorization: `Bearer ${settings.token.trim()}` }
                : {},
        });
    } catch {
        throw new ExplorerError("Nessuna connessione a Lichess.", "network");
    }
    if (res.status === 401 || res.status === 403) {
        throw new ExplorerError(
            settings.token.trim()
                ? "Lichess ha rifiutato il token: controllalo qui sotto."
                : "Lichess richiede un token personale gratuito: inseriscilo qui sotto.",
            "token",
        );
    }
    if (res.status === 429)
        throw new ExplorerError("Troppe richieste a Lichess, riprova tra un minuto.", "rate");
    if (!res.ok) throw new ExplorerError(`Errore Lichess (${res.status}).`, "other");
    const data = (await res.json()) as ExplorerResult;
    const result: ExplorerResult = {
        white: data.white ?? 0,
        draws: data.draws ?? 0,
        black: data.black ?? 0,
        moves: data.moves ?? [],
        opening: data.opening ?? null,
    };
    cache.set(url, result);
    return result;
}

/** 1234 -> "1,2k", 2500000 -> "2,5M" */
export function formatGames(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(".", ",")}M`;
    if (n >= 10_000) return `${Math.round(n / 1000)}k`;
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace(".", ",")}k`;
    return String(n);
}
