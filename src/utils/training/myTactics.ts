// Your own tactics (from books, puzzles...), kept in collections: one PGN file per
// collection in the "Tattiche" folder, one game per tactic. The game starts at the
// position, its main line is the solution (your moves and the replies), variations and
// comments are the explanation. Shared by the PC and the phone.

import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import type { TreeNode } from "@/utils/treeReducer";
import { gameSpans, readGame, writeMovetext } from "../repertoireEdit";

/** Folder of the collections, in the synced folder. */
export const TACTICS_FOLDER = "Tattiche";
/** File type of a collection (in its .info), so that it is not taken for a repertoire. */
export const TACTICS_FILE_TYPE = "tactics";

export type MyTactic = {
    /** The game's TacticId header (or file#index when missing). */
    id: string;
    collection: string;
    /** The collection file: path on the PC, relative path on the phone. */
    file: string;
    /** Index of the game in the file. */
    game: number;
    fen: string;
    /** Side to move: yours. */
    color: "white" | "black";
    tags: string[];
    /** The solution: main line from the position (SAN, alternating sides). */
    line: string[];
    root: TreeNode;
};

/** "matto, Inchiodatura ,matto" -> ["matto", "Inchiodatura"] (same tag ignoring case once). */
export function normalizeTags(tags: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of tags.flatMap((t) => t.split(","))) {
        const tag = raw.trim().replace(/\s+/g, " ");
        if (tag && !seen.has(tag.toLowerCase())) {
            seen.add(tag.toLowerCase());
            out.push(tag);
        }
    }
    return out;
}

export function parseCollection(text: string, collection: string, file: string): MyTactic[] {
    const tactics: MyTactic[] = [];
    gameSpans(text).forEach((span, game) => {
        const read = readGame(text, game);
        if (!read) return;
        const fen = read.root.fen;
        const line: string[] = [];
        for (let node = read.root.children[0]; node; node = node.children[0]) {
            if (node.san) line.push(node.san);
        }
        if (line.length === 0) return;
        tactics.push({
            id: span.headers.get("TacticId") || `${file}#${game}`,
            collection,
            file,
            game,
            fen,
            color: fen.split(" ")[1] === "b" ? "black" : "white",
            tags: normalizeTags([span.headers.get("Tags") ?? ""]),
            line,
            root: read.root,
        });
    });
    return tactics;
}

export function newTacticId(): string {
    return `t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const escape = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

/** The PGN of a tactic: its position, solution, variations and comments. */
export function tacticPgn({
    collection,
    id,
    tags,
    root,
}: {
    collection: string;
    id: string;
    tags: readonly string[];
    root: TreeNode;
}): string {
    const color = root.fen.split(" ")[1] === "b" ? "black" : "white";
    const headers: [string, string][] = [
        ["Event", collection],
        ["Site", "?"],
        ["Date", "????.??.??"],
        ["Round", "?"],
        ["White", "?"],
        ["Black", "?"],
        ["Result", "*"],
        ["SetUp", "1"],
        ["FEN", root.fen],
        ["Orientation", color],
        ["TacticId", id],
    ];
    if (tags.length > 0) headers.push(["Tags", tags.join(", ")]);
    return `${headers.map(([k, v]) => `[${k} "${escape(v)}"]`).join("\n")}\n\n${writeMovetext(root, "*")}\n`;
}

/** The collection's text with one more tactic at the end. */
export function appendTactic(text: string | null, pgn: string): string {
    const body = (text ?? "").trimEnd();
    return body ? `${body}\n\n${pgn}` : pgn;
}

/** Why a position cannot be saved as a tactic, if it cannot. */
export function tacticProblem(root: TreeNode): "NoSolution" | null {
    return root.children[0]?.san ? null : "NoSolution";
}

/** Every tag used, most used first. */
export function tagsOf(tactics: readonly MyTactic[]): string[] {
    const count = new Map<string, { tag: string; n: number }>();
    for (const t of tactics) {
        for (const tag of t.tags) {
            const key = tag.toLowerCase();
            const c = count.get(key) ?? { tag, n: 0 };
            c.n++;
            count.set(key, c);
        }
    }
    return [...count.values()]
        .sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag))
        .map((c) => c.tag);
}

/** Tactics of the chosen collections (all when none) having all the chosen tags. */
export function selectTactics(
    tactics: readonly MyTactic[],
    collections: readonly string[],
    tags: readonly string[],
): MyTactic[] {
    const wanted = tags.map((t) => t.toLowerCase());
    return tactics.filter(
        (t) =>
            (collections.length === 0 || collections.includes(t.collection)) &&
            wanted.every((w) => t.tags.some((x) => x.toLowerCase() === w)),
    );
}

export function shuffled<T>(items: readonly T[], random = Math.random): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

// --- Solving ---

export type Attempt = {
    /** Moves played so far on the solution line (yours and the replies). */
    ply: number;
    /** Wrong tries at the current move. */
    misses: number;
    /** "solved": all your moves found; "failed": shown after the second miss or on request. */
    state: "playing" | "solved" | "failed";
    /** At least one miss: the tactic counts as wrong even if finished. */
    missed: boolean;
};

export const newAttempt = (): Attempt => ({ ply: 0, misses: 0, state: "playing", missed: false });

/** After your move `san`: right ones advance (and the reply with them), wrong ones count. */
export function answer(tactic: MyTactic, attempt: Attempt, san: string): Attempt {
    if (attempt.state !== "playing") return attempt;
    if (san === tactic.line[attempt.ply]) {
        const ply = Math.min(attempt.ply + 2, tactic.line.length);
        // Your last move of the line, or the reply after it, ends the tactic.
        return {
            ...attempt,
            ply,
            misses: 0,
            state: attempt.ply + 1 >= tactic.line.length - 1 ? "solved" : "playing",
        };
    }
    const misses = attempt.misses + 1;
    return { ...attempt, misses, missed: true, state: misses >= 2 ? "failed" : "playing" };
}

export function giveUp(attempt: Attempt): Attempt {
    return attempt.state === "playing" ? { ...attempt, state: "failed", missed: true } : attempt;
}

/** FEN after the first `ply` moves of the solution. */
export function fenAfter(tactic: MyTactic, ply: number): string {
    let node = tactic.root;
    for (let i = 0; i < ply && node.children[0]; i++) node = node.children[0];
    return node.fen;
}

/** The squares of the `ply`-th move of the solution (for the last-move highlight). */
export function moveSquares(tactic: MyTactic, ply: number): [string, string] | undefined {
    let node = tactic.root;
    for (let i = 0; i < ply && node.children[0]; i++) node = node.children[0];
    const uci = node.move && "from" in node.move ? node.move : null;
    if (!uci) return undefined;
    const name = (sq: number) => `${"abcdefgh"[sq % 8]}${Math.floor(sq / 8) + 1}`;
    return [name(uci.from), name(uci.to)];
}

// --- Solution, for display ---

export type SolutionPart =
    | { kind: "move"; label: string; san: string; fen: string; main: boolean }
    | { kind: "comment"; text: string }
    | { kind: "variation"; parts: SolutionPart[] };

const MARKUP = /\[%[^\]]*\]/g;

/** The solution as moves, comments and variations (comments without [%...] markup). */
export function solutionParts(root: TreeNode): SolutionPart[] {
    const parts: SolutionPart[] = [];
    if (root.comment?.replace(MARKUP, "").trim()) {
        parts.push({ kind: "comment", text: root.comment.replace(MARKUP, "").trim() });
    }
    walk(root, true, parts, true);
    return parts;
}

function moveLabel(node: TreeNode, forceNumber: boolean): string {
    const n = Math.floor((node.halfMoves - 1) / 2) + 1;
    const white = node.halfMoves % 2 === 1;
    return white ? `${n}.` : forceNumber ? `${n}...` : "";
}

function walk(from: TreeNode, main: boolean, out: SolutionPart[], number: boolean) {
    let node = from;
    let forceNumber = number;
    while (node.children.length > 0) {
        const [first, ...others] = node.children;
        out.push(move(first, main, forceNumber));
        forceNumber = false;
        const comment = first.comment?.replace(MARKUP, "").trim();
        if (comment) {
            out.push({ kind: "comment", text: comment });
            forceNumber = true;
        }
        for (const other of others) {
            const parts: SolutionPart[] = [move(other, false, true)];
            const c = other.comment?.replace(MARKUP, "").trim();
            if (c) parts.push({ kind: "comment", text: c });
            walk(other, false, parts, !!c);
            out.push({ kind: "variation", parts });
            forceNumber = true;
        }
        node = first;
    }
}

const GLYPHS = new Set(["!", "?", "!!", "??", "!?", "?!"]);

function move(node: TreeNode, main: boolean, forceNumber: boolean): SolutionPart {
    const glyphs = (node.annotations ?? []).filter((a) => GLYPHS.has(a)).join("");
    return {
        kind: "move",
        label: moveLabel(node, forceNumber),
        san: `${node.san ?? ""}${glyphs}`,
        fen: node.fen,
        main,
    };
}

/** True if the position is legal to start from (the solution must be playable too). */
export function playableFrom(fen: string): boolean {
    const setup = parseFen(fen);
    return setup.isOk && Chess.fromSetup(setup.value).isOk;
}
