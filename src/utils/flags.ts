// Moves flagged "to review" (usually from the phone), with a note, so that they can be
// found again on the PC. Kept in the progress file of their PGN and synced like the
// pause state: they follow renames, and every device merges them by id.

export type ReviewFlag = {
    id: string;
    /** Game index inside the PGN file. */
    game: number;
    /** SAN moves from the start of the game up to the flagged move (included). */
    line: string[];
    text: string;
    /** Device that created the flag ("Android", "PC"). */
    device: string;
    createdAt: string;
    /** Last change (text or resolution): the newest version of a flag wins. */
    updatedAt: string;
    /** Set when the flag has been dealt with. */
    resolvedAt?: string;
};

/** Resolved flags are forgotten after this long (until then they stop other devices re-adding them). */
const KEEP_RESOLVED_MS = 60 * 24 * 3600 * 1000;

export function newFlagId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function newer(a: ReviewFlag, b: ReviewFlag): ReviewFlag {
    return new Date(b.updatedAt).getTime() > new Date(a.updatedAt).getTime() ? b : a;
}

/** Union of two lists by id (the most recent version wins), old resolved flags dropped. */
export function mergeFlags(
    a: readonly ReviewFlag[],
    b: readonly ReviewFlag[],
    now: Date = new Date(),
): ReviewFlag[] {
    const byId = new Map<string, ReviewFlag>();
    for (const f of [...a, ...b]) {
        const known = byId.get(f.id);
        byId.set(f.id, known ? newer(known, f) : f);
    }
    return [...byId.values()]
        .filter(
            (f) =>
                !f.resolvedAt ||
                now.getTime() - new Date(f.resolvedAt).getTime() < KEEP_RESOLVED_MS,
        )
        .sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id));
}

export function isValidFlag(f: unknown): f is ReviewFlag {
    const x = f as ReviewFlag;
    return (
        !!x &&
        typeof x.id === "string" &&
        typeof x.game === "number" &&
        Array.isArray(x.line) &&
        x.line.every((s) => typeof s === "string") &&
        typeof x.text === "string" &&
        typeof x.createdAt === "string" &&
        typeof x.updatedAt === "string"
    );
}

export const openFlags = (flags: readonly ReviewFlag[]) => flags.filter((f) => !f.resolvedAt);

/** Open flag of a given move (same game and line), if any. */
export function flagAt(
    flags: readonly ReviewFlag[],
    game: number,
    line: readonly string[],
): ReviewFlag | undefined {
    const key = line.join(" ");
    return flags.find((f) => !f.resolvedAt && f.game === game && f.line.join(" ") === key);
}

/**
 * Adds, changes or (with an empty text) resolves the open flag of a move. Returns the
 * new list, unchanged when there is nothing to do.
 */
export function setFlag(
    flags: readonly ReviewFlag[],
    game: number,
    line: readonly string[],
    text: string,
    device: string,
    now: Date = new Date(),
): ReviewFlag[] {
    const at = now.toISOString();
    const existing = flagAt(flags, game, line);
    const clean = text.trim();
    if (existing) {
        const updated: ReviewFlag = clean
            ? { ...existing, text: clean, updatedAt: at }
            : { ...existing, resolvedAt: at, updatedAt: at };
        return flags.map((f) => (f.id === existing.id ? updated : f));
    }
    if (!clean) return [...flags];
    return [
        ...flags,
        {
            id: newFlagId(),
            game,
            line: [...line],
            text: clean,
            device,
            createdAt: at,
            updatedAt: at,
        },
    ];
}

/** Marks a flag as dealt with. */
export function resolveFlag(
    flags: readonly ReviewFlag[],
    id: string,
    now: Date = new Date(),
): ReviewFlag[] {
    const at = now.toISOString();
    return flags.map((f) => (f.id === id ? { ...f, resolvedAt: at, updatedAt: at } : f));
}

/** "7. Be2" / "7... Re8": the flagged move with its number. */
export function flagMoveLabel(flag: Pick<ReviewFlag, "line">, startPly = 0): string {
    const ply = startPly + flag.line.length - 1;
    if (ply < 0) return "";
    const n = Math.floor(ply / 2) + 1;
    return `${n}.${ply % 2 ? ".." : ""} ${flag.line[flag.line.length - 1]}`;
}
