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
    /** Whether the repertoire is paused (left out of reviews); absent = never paused. */
    pause?: PauseState;
    /** Notes written on moves (also moves outside the repertoire); absent = none. */
    notes?: Note[];
};

/**
 * A note on a move, written on any device. Kept apart from the PGN: it never changes
 * the repertoire. Deleting one leaves a tombstone so the deletion reaches every device.
 */
export type Note = {
    id: string;
    /** Game index inside the PGN file. */
    game: number;
    /** Position the line starts from (the repertoire's start position). */
    startFen: string;
    /** SAN moves from `startFen`; the note is about the last one. */
    line: string[];
    /** Position after the line. */
    fen: string;
    text: string;
    device: string;
    created: string;
    updated: string;
    deleted?: boolean;
};

/** Union of two note lists; for a note edited on both sides the latest edit wins. */
export function mergeNotes(a: readonly Note[], b: readonly Note[]): Note[] {
    const byId = new Map<string, Note>();
    for (const note of [...a, ...b]) {
        const prev = byId.get(note.id);
        if (!prev || new Date(note.updated).getTime() > new Date(prev.updated).getTime())
            byId.set(note.id, note);
    }
    return [...byId.values()].sort(
        (x, y) => x.created.localeCompare(y.created) || x.id.localeCompare(y.id),
    );
}

/** Notes still shown (not deleted). */
export function liveNotes(notes: readonly Note[] | undefined): Note[] {
    return (notes ?? []).filter((n) => !n.deleted);
}

function isNote(value: unknown): value is Note {
    const n = value as Note;
    return (
        !!n &&
        typeof n.id === "string" &&
        typeof n.fen === "string" &&
        typeof n.text === "string" &&
        Array.isArray(n.line) &&
        typeof n.updated === "string" &&
        typeof n.created === "string"
    );
}

/** Pause state of a repertoire, synced between devices: the latest change wins. */
export type PauseState = {
    paused: boolean;
    /** ISO date of the last change. */
    changedAt: string;
};

/** The most recent of two pause states (either may be missing). */
export function newerPause(a: PauseState | null, b: PauseState | null): PauseState | null {
    if (!a) return b;
    if (!b) return a;
    return new Date(b.changedAt).getTime() > new Date(a.changedAt).getTime() ? b : a;
}

export function isPaused(state: PauseState | null | undefined): boolean {
    return state?.paused === true;
}

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

export type Rename = { from: string; to: string; side: "local" | "remote" };

/**
 * Finds repertoires that were renamed or moved: a PGN that disappeared on one side
 * while a PGN with exactly the same content appeared on the same side.
 * - local rename (this device): deleteRemote(from) + upload(to), same blob
 * - remote rename (another device): deleteLocal(from) + download(to), same blob
 */
export function detectRenames(
    actions: ContentAction[],
    local: Map<string, string>,
    remote: Map<string, string>,
): Rename[] {
    const isPgn = (p: string) => p.toLowerCase().endsWith(".pgn");
    const renames: Rename[] = [];
    const pair = (
        gone: string[],
        added: string[],
        goneSha: (p: string) => string | undefined,
        addedSha: (p: string) => string | undefined,
        side: Rename["side"],
    ) => {
        const free = new Set(added);
        for (const from of gone) {
            const sha = goneSha(from);
            if (!sha) continue;
            const to = [...free].find((q) => addedSha(q) === sha);
            if (!to) continue;
            free.delete(to);
            renames.push({ from, to, side });
        }
    };
    const paths = (kind: ContentAction["kind"]) =>
        actions.filter((a) => a.kind === kind && isPgn(a.path)).map((a) => a.path);
    pair(
        paths("deleteRemote"),
        paths("upload").filter((q) => !remote.has(q)),
        (p) => remote.get(p),
        (q) => local.get(q),
        "local",
    );
    pair(
        paths("deleteLocal"),
        paths("download").filter((q) => !local.has(q)),
        (p) => local.get(p),
        (q) => remote.get(q),
        "remote",
    );
    return renames;
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
export function serializeProgress(
    games: Record<string, PracticeData>,
    pause: PauseState | null = null,
    notes: readonly Note[] = [],
): string {
    const sorted: Record<string, PracticeData> = {};
    for (const key of Object.keys(games).sort((a, b) => Number(a) - Number(b))) {
        sorted[key] = games[key];
    }
    const file: ProgressFile = {
        version: PROGRESS_VERSION,
        games: sorted,
        ...(pause ? { pause } : {}),
        ...(notes.length > 0 ? { notes: mergeNotes(notes, []) } : {}),
    };
    return `${JSON.stringify(canonical(file), null, 2)}\n`;
}

/**
 * Copy of a JSON value with object keys in a fixed order. Desktop and phone build
 * the same cards and logs with keys in different orders; without this every sync
 * rewrote all progress files even when nothing had changed.
 */
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object" && !(value instanceof Date)) {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value).sort()) {
            const v = (value as Record<string, unknown>)[key];
            if (v !== undefined) out[key] = canonical(v);
        }
        return out;
    }
    return value;
}

export function parseProgress(text: string): Record<string, PracticeData> {
    return parseProgressFile(text).games;
}

export function parseProgressFile(text: string): {
    games: Record<string, PracticeData>;
    pause: PauseState | null;
    notes: Note[];
} {
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
    const pause =
        parsed.pause &&
        typeof parsed.pause.paused === "boolean" &&
        typeof parsed.pause.changedAt === "string"
            ? parsed.pause
            : null;
    const notes = Array.isArray(parsed.notes) ? parsed.notes.filter(isNote) : [];
    return { games, pause, notes };
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
