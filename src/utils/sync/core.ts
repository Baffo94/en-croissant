// Pure logic for syncing repertoires and practice progress with a GitHub repository.
// Nothing in this file touches the network, the filesystem or localStorage, so it
// can be unit tested and reused by the mobile app.

import type { PracticeData } from "@/components/files/opening";

/** Remote folder that mirrors the local sync folder (PGN + .info files). */
export const REPERTOIRES_PREFIX = "repertoires/";
/** Remote folder holding one progress JSON per PGN file. */
export const PROGRESS_PREFIX = "progress/";
export const PROGRESS_VERSION = 1;

/** Extensions of the "content" files mirrored from the local sync folder. */
export const CONTENT_EXTENSIONS = [".pgn", ".info"];

export type ProgressFile = {
    version: number;
    /** Key: game index inside the PGN file ("0", "1", ...). */
    games: Record<string, PracticeData>;
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Normalises a path for comparisons: forward slashes, no trailing slash, case-insensitive. */
export function normalizePath(path: string): string {
    return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Returns the path of `file` relative to `folder` using forward slashes,
 * or null if the file is not inside the folder.
 */
export function relativePath(folder: string, file: string): string | null {
    const f = file.replace(/\\/g, "/");
    const base = folder.replace(/\\/g, "/").replace(/\/+$/, "");
    if (f.length <= base.length + 1) return null;
    if (f.slice(0, base.length).toLowerCase() !== base.toLowerCase()) return null;
    if (f[base.length] !== "/") return null;
    return f.slice(base.length + 1);
}

export function isContentPath(path: string): boolean {
    const lower = path.toLowerCase();
    return CONTENT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** "Openings/Sicilian.pgn" -> "progress/Openings/Sicilian.json" */
export function progressPathFor(relPgnPath: string): string {
    return `${PROGRESS_PREFIX}${relPgnPath.replace(/\.pgn$/i, "")}.json`;
}

// ---------------------------------------------------------------------------
// Git blob hashing (same id GitHub uses, so unchanged files are never re-uploaded)
// ---------------------------------------------------------------------------

export async function gitBlobSha(content: Uint8Array): Promise<string> {
    const header = new TextEncoder().encode(`blob ${content.byteLength}\0`);
    const data = new Uint8Array(header.byteLength + content.byteLength);
    data.set(header, 0);
    data.set(content, header.byteLength);
    const digest = await crypto.subtle.digest("SHA-1", data);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

// ---------------------------------------------------------------------------
// Content files (PGN / .info): three-way comparison local / remote / last sync
// ---------------------------------------------------------------------------

export type ContentAction =
    | { kind: "upload"; path: string }
    | { kind: "download"; path: string }
    | { kind: "deleteRemote"; path: string }
    | { kind: "deleteLocal"; path: string }
    /** Both sides changed: keep the local file, save the remote one as a copy. */
    | { kind: "conflict"; path: string };

/**
 * Decides what to do with every content file.
 * Maps are keyed by path relative to the sync folder and hold git blob shas.
 * `base` is the state recorded at the end of the previous successful sync.
 */
export function planContentSync(
    local: Map<string, string>,
    remote: Map<string, string>,
    base: Map<string, string>,
): ContentAction[] {
    const actions: ContentAction[] = [];
    const paths = new Set([...local.keys(), ...remote.keys()]);
    for (const path of [...paths].sort()) {
        const l = local.get(path);
        const r = remote.get(path);
        const b = base.get(path);
        if (l === r) continue;
        if (l === undefined) {
            // Missing locally: deleted here (if remote is what we last saw) or new remotely.
            actions.push(
                b !== undefined && b === r
                    ? { kind: "deleteRemote", path }
                    : { kind: "download", path },
            );
        } else if (r === undefined) {
            // Missing remotely: deleted elsewhere (if local is unchanged) or new locally.
            actions.push(
                b !== undefined && b === l
                    ? { kind: "deleteLocal", path }
                    : { kind: "upload", path },
            );
        } else if (b === r) {
            actions.push({ kind: "upload", path });
        } else if (b === l) {
            actions.push({ kind: "download", path });
        } else {
            actions.push({ kind: "conflict", path });
        }
    }
    return actions;
}

/** "Openings/Sicilian.pgn" -> "Openings/Sicilian (conflict 2026-11-01 1530).pgn" */
export function conflictCopyPath(path: string, date: Date): string {
    const pad = (n: number) => n.toString().padStart(2, "0");
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
    const dot = path.lastIndexOf(".");
    const slash = path.lastIndexOf("/");
    if (dot <= slash) return `${path} (conflict ${stamp})`;
    return `${path.slice(0, dot)} (conflict ${stamp})${path.slice(dot)}`;
}

// ---------------------------------------------------------------------------
// Practice progress merge
// ---------------------------------------------------------------------------

type AnyCard = PracticeData["positions"][number]["card"];

function time(value: unknown): number {
    if (value === undefined || value === null) return Number.NEGATIVE_INFINITY;
    const t = new Date(value as string | number | Date).getTime();
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** The card reviewed most recently wins; ties are broken by number of reviews. */
export function newerCard(a: AnyCard, b: AnyCard): AnyCard {
    const ta = time(a.last_review);
    const tb = time(b.last_review);
    if (ta !== tb) return ta > tb ? a : b;
    return (b.reps ?? 0) > (a.reps ?? 0) ? b : a;
}

function logKey(log: PracticeData["logs"][number]): string {
    return `${log.fen}|${time(log.review)}|${log.rating}`;
}

/**
 * Merges the local deck with the remote one.
 *
 * - The list of positions comes from the local deck when it is not empty, because the
 *   desktop app rebuilds it from the PGN (the source of truth). An empty local deck
 *   (e.g. a file never practiced on this computer) takes the remote positions.
 * - For each position the most recently reviewed card wins.
 * - Review logs are the union of both sides, without duplicates, ordered by time.
 */
export function mergeDecks(local: PracticeData, remote: PracticeData): PracticeData {
    const remoteByFen = new Map(remote.positions.map((p) => [p.fen, p]));
    const source = local.positions.length > 0 ? local.positions : remote.positions;
    const positions = source.map((pos) => {
        const other = remoteByFen.get(pos.fen);
        if (!other) return pos;
        const card = newerCard(pos.card, other.card);
        return card === pos.card ? pos : { ...pos, card };
    });

    const seen = new Set<string>();
    const logs: PracticeData["logs"] = [];
    for (const log of [...local.logs, ...remote.logs]) {
        const key = logKey(log);
        if (seen.has(key)) continue;
        seen.add(key);
        logs.push(log);
    }
    logs.sort((a, b) => time(a.review) - time(b.review));

    return { positions, logs };
}

export function emptyDeck(): PracticeData {
    return { positions: [], logs: [] };
}

export function isEmptyDeck(deck: PracticeData): boolean {
    return deck.positions.length === 0 && deck.logs.length === 0;
}

/** Stable JSON so that identical progress always produces the same blob sha. */
export function serializeProgress(games: Record<string, PracticeData>): string {
    const sorted: Record<string, PracticeData> = {};
    for (const key of Object.keys(games).sort((a, b) => Number(a) - Number(b))) {
        sorted[key] = games[key];
    }
    const file: ProgressFile = { version: PROGRESS_VERSION, games: sorted };
    return `${JSON.stringify(file, null, 2)}\n`;
}

export function parseProgress(text: string): Record<string, PracticeData> {
    const parsed = JSON.parse(text) as Partial<ProgressFile>;
    if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.games !== "object" ||
        !parsed.games
    ) {
        throw new Error("Invalid progress file");
    }
    const games: Record<string, PracticeData> = {};
    for (const [key, deck] of Object.entries(parsed.games)) {
        games[key] = {
            positions: Array.isArray(deck?.positions) ? deck.positions : [],
            logs: Array.isArray(deck?.logs) ? deck.logs : [],
        };
    }
    return games;
}

// ---------------------------------------------------------------------------
// localStorage deck keys: "deck-<absolute file path>-<game>"
// ---------------------------------------------------------------------------

export function parseDeckKey(key: string): { file: string; game: number } | null {
    if (!key.startsWith("deck-")) return null;
    const match = /^deck-(.+)-(\d+)$/.exec(key);
    if (!match) return null;
    return { file: match[1], game: Number(match[2]) };
}

export function deckKey(file: string, game: number): string {
    return `deck-${file}-${game}`;
}

/** File name without folders, lower-cased (used to recover progress of moved files). */
export function baseName(path: string): string {
    const parts = path.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1].toLowerCase();
}
