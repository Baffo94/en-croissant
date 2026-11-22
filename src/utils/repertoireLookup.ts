// Where is a position in your repertoires? And, when it is in none, where should it go?
// Pure functions: the index is built from the files' texts, the suggestions from the
// line on the board and the opening's name.

import type { TreeNode } from "@/utils/treeReducer";
import { parsePgnGames } from "./pgnTree";

export type Color = "white" | "black";

export type RepFile = {
    path: string;
    /** "Group · Section", or the file's name. */
    label: string;
    group: string;
    name: string;
    orientation: Color;
    /** Root of each game (index = game number). */
    roots: TreeNode[];
};

export type Occurrence = {
    file: RepFile;
    game: number;
    /** The moves leading to the position in that file. */
    line: string[];
    /** The moves stored there (the first is the main one). */
    moves: string[];
    /** True if it is the repertoire's side to move (the moves are yours). */
    yours: boolean;
};

export type RepIndex = { files: RepFile[]; byKey: Map<string, Occurrence[]> };

/** Pieces, side to move and castling: the same position whatever the move order. */
export function positionKey(fen: string): string {
    return fen.split(" ").slice(0, 3).join(" ");
}

export function buildIndex(
    sources: { path: string; label: string; group: string; name: string; text: string }[],
): RepIndex {
    const files: RepFile[] = [];
    const byKey = new Map<string, Occurrence[]>();
    for (const source of sources) {
        let games: ReturnType<typeof parsePgnGames>;
        try {
            games = parsePgnGames(source.text);
        } catch {
            continue;
        }
        if (games.length === 0) continue;
        const file: RepFile = {
            path: source.path,
            label: source.label,
            group: source.group,
            name: source.name,
            orientation: games[0].orientation,
            roots: games.map((g) => g.root),
        };
        files.push(file);
        games.forEach((g, game) => {
            const seen = new Set<string>();
            const visit = (node: TreeNode, line: string[]) => {
                const key = positionKey(node.fen);
                // Once per file and game: the first (main line first) way there.
                if (!seen.has(key)) {
                    seen.add(key);
                    const moves = node.children.map((c) => c.san ?? "").filter(Boolean);
                    const toMove = node.fen.split(" ")[1] === "b" ? "black" : "white";
                    const list = byKey.get(key) ?? [];
                    list.push({ file, game, line, moves, yours: toMove === g.orientation });
                    byKey.set(key, list);
                }
                for (const child of node.children) {
                    if (child.san) visit(child, [...line, child.san]);
                }
            };
            visit(g.root, []);
        });
    }
    return { files, byKey };
}

/** The repertoires having this position (of one colour, or all). */
export function lookup(index: RepIndex, fen: string, color: Color | null): Occurrence[] {
    return (index.byKey.get(positionKey(fen)) ?? []).filter(
        (o) => color === null || o.file.orientation === color,
    );
}

// --- Suggestions ---

const STOP = new Set([
    "defense",
    "defence",
    "variation",
    "variations",
    "opening",
    "game",
    "the",
    "of",
    "line",
    "main",
    "with",
    "and",
    "other",
    "altre",
    "varianti",
    "variante",
    "difesa",
    "apertura",
    "partita",
    "linea",
    "principale",
    "di",
    "del",
    "della",
    "la",
    "il",
    "contro",
    "against",
    "bianco",
    "nero",
]);

/** Italian names of your files, in the words of the openings' (English) names. */
const SYNONYMS: [RegExp, string][] = [
    [/\bsiciliana\b/g, "sicilian"],
    [/\bfrancese\b/g, "french"],
    [/\bscozzese\b/g, "scotch"],
    [/\best indiana\b/g, "kings indian"],
    [/\bovest indiana\b/g, "queens indian"],
    [/\bnimzo indiana\b/g, "nimzo indian"],
    [/\binglese\b/g, "english"],
    [/\bspagnola\b/g, "ruy lopez spanish"],
    [/\bitaliana\b/g, "italian giuoco piano"],
    [/\bscandinava\b/g, "scandinavian"],
    [/\bolandese\b/g, "dutch"],
    [/\bslava\b/g, "slav"],
    [/\bgambetto di donna\b/g, "queens gambit"],
    [/\bgambetto di re\b/g, "kings gambit"],
    [/\bgambetto\b/g, "gambit"],
    [/\bcatalana\b/g, "catalan"],
    [/\bmoderna\b/g, "modern"],
    [/\blondra\b/g, "london"],
    [/\bdragone\b/g, "dragon"],
    [/\baccelerato\b/g, "accelerated"],
    [/\bquattro cavalli\b/g, "four knights"],
    [/\bdue cavalli\b/g, "two knights"],
    [/\bscambio\b/g, "exchange"],
    [/\bavanzata\b/g, "advance"],
    [/\bpetrov\b/g, "petrov russian"],
    [/\bcontrogambetto\b/g, "countergambit"],
];

export function nameTokens(text: string): string[] {
    let s = text
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/['’]/g, "")
        .replace(/[-_:,.()/]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    for (const [re, en] of SYNONYMS) s = s.replace(re, en);
    s = s.replace(/counter gambit/g, "countergambit");
    return [...new Set(s.split(" ").filter((w) => w.length > 1 && !STOP.has(w)))];
}

export type Reason =
    | { kind: "learned" }
    | { kind: "shared"; plies: number; after: string[] }
    | { kind: "name"; words: string[] };

export type Suggestion = {
    file: RepFile;
    game: number;
    score: number;
    reasons: Reason[];
    /** The moves to add (from the start of that game), or null if the line cannot go there. */
    addLine: string[] | null;
    /** The moves of the line that the file does not have yet. */
    missing: string[];
};

/**
 * Where the line on the board could go, best first: the file you chose before for this
 * opening, the file that already has the furthest position of the line, the file whose
 * name matches the opening's name.
 */
export function suggest(
    index: RepIndex,
    line: { fens: string[]; sans: string[] },
    opening: string,
    color: Color | null,
    learned: Record<string, string>,
): Suggestion[] {
    const openingWords = nameTokens(opening);
    const family = nameTokens(opening.split(":")[0] ?? "");
    const out: Suggestion[] = [];
    for (const file of index.files) {
        if (color !== null && file.orientation !== color) continue;
        // The furthest position of the line the file already has.
        let anchor: { line: string[]; plies: number; game: number } | null = null;
        for (let i = line.fens.length - 1; i >= 0 && !anchor; i--) {
            const found = (index.byKey.get(positionKey(line.fens[i])) ?? []).find(
                (o) => o.file === file,
            );
            if (found) anchor = { line: found.line, plies: i, game: found.game };
        }
        const reasons: Reason[] = [];
        let score = 0;
        if (learned[opening] === file.path) {
            reasons.push({ kind: "learned" });
            score += 1000;
        }
        if (anchor && anchor.plies > 0) {
            reasons.push({
                kind: "shared",
                plies: anchor.plies,
                after: line.sans.slice(0, anchor.plies),
            });
            score += anchor.plies * 3;
        }
        const fileWords = nameTokens(`${file.group} ${file.name}`);
        const common = openingWords.filter((w) => fileWords.includes(w));
        if (common.length > 0) {
            reasons.push({ kind: "name", words: common });
            const familyHit = family.length > 0 && family.every((w) => fileWords.includes(w));
            score += common.length * 4 + (familyHit ? 6 : 0);
        }
        if (score === 0) continue;
        const missing = anchor ? line.sans.slice(anchor.plies) : line.sans;
        out.push({
            file,
            game: anchor?.game ?? 0,
            score,
            reasons,
            addLine: anchor ? [...anchor.line, ...missing] : null,
            missing,
        });
    }
    return out.sort((a, b) => b.score - a.score || a.file.label.localeCompare(b.file.label));
}

/** Where the line goes in a file chosen by hand (null if it shares no position with it). */
export function placeIn(
    index: RepIndex,
    file: RepFile,
    line: { fens: string[]; sans: string[] },
): { game: number; addLine: string[]; missing: string[] } | null {
    for (let i = line.fens.length - 1; i >= 0; i--) {
        const found = (index.byKey.get(positionKey(line.fens[i])) ?? []).find(
            (o) => o.file === file,
        );
        if (found) {
            const missing = line.sans.slice(i);
            return { game: found.game, addLine: [...found.line, ...missing], missing };
        }
    }
    return null;
}
