// Edits of a repertoire made away from the desktop board (the phone): add a move,
// delete one, make a variation the main line, comments and symbols.
//
// The game is read and written exactly as the desktop app does when it saves a file
// (same tree parser, same PGN writer), so a file edited on the phone looks as if it had
// been saved on the PC. Only the movetext of the edited game is rewritten: its headers
// and the other games of the file stay byte for byte.
//
// Every edit is idempotent (adding a move already there, deleting one already gone...
// change nothing), so pending edits can be applied again on top of a version changed
// meanwhile on the PC. Each edit also returns its inverse, used to undo it later.

import { INITIAL_FEN } from "chessops/fen";
import type { Token } from "@/bindings";
import { type Annotation, isBasicAnnotation } from "./annotation";
import { getPGN, innerParsePGN } from "./chess";
import { type PgnToken, tokenize } from "./pgnEdit";
import type { TreeNode } from "./treeReducer";

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/** A move is identified by its line: the SAN moves from the start of the game. */
export type RepertoireOp =
    /** Adds the last move of `line` (a new continuation, or a new variation). */
    | { kind: "add"; line: string[] }
    /** Deletes the move and everything after it. */
    | { kind: "delete"; line: string[] }
    /** Makes the move the main continuation of the position before it. */
    | { kind: "promote"; line: string[] }
    /** Comment of the move (of the game itself for an empty line). */
    | { kind: "comment"; line: string[]; text: string }
    /** Move symbols (!, ?, !!, ??, !?, ?!); other annotations are kept. */
    | { kind: "nags"; line: string[]; nags: Annotation[] }
    /** Puts back a deleted move with what followed it (undo of "delete"). */
    | { kind: "restore"; line: string[]; index: number; node: TreeNode };

export type OpResult = { changed: boolean; inverse: RepertoireOp | null };

const MOVE_SYMBOLS: Annotation[] = ["!!", "!", "!?", "?!", "?", "??"];

/** The node reached by `line`, with its parent and its index there. */
function find(
    root: TreeNode,
    line: readonly string[],
): { node: TreeNode; parent: TreeNode | null; index: number } | null {
    let node = root;
    let parent: TreeNode | null = null;
    let index = -1;
    for (const san of line) {
        const i = node.children.findIndex((c) => c.san === san);
        if (i < 0) return null;
        parent = node;
        index = i;
        node = node.children[i];
    }
    return { node, parent, index };
}

/** Applies `op` to the game tree (in place). */
export function applyOpToTree(root: TreeNode, op: RepertoireOp): OpResult {
    const none: OpResult = { changed: false, inverse: null };
    switch (op.kind) {
        case "add": {
            if (op.line.length === 0) return none;
            const parentLine = op.line.slice(0, -1);
            const san = op.line[op.line.length - 1];
            const at = find(root, parentLine);
            if (!at) return none;
            if (at.node.children.some((c) => c.san === san)) return none;
            const child = playSan(at.node, san);
            if (!child) return none;
            at.node.children.push(child);
            return { changed: true, inverse: { kind: "delete", line: [...op.line] } };
        }
        case "delete": {
            const at = find(root, op.line);
            if (!at || !at.parent) return none;
            at.parent.children.splice(at.index, 1);
            return {
                changed: true,
                inverse: {
                    kind: "restore",
                    line: [...op.line],
                    index: at.index,
                    node: structuredClone(at.node),
                },
            };
        }
        case "restore": {
            const parentLine = op.line.slice(0, -1);
            const at = find(root, parentLine);
            if (!at) return none;
            if (at.node.children.some((c) => c.san === op.node.san)) return none;
            const index = Math.max(0, Math.min(op.index, at.node.children.length));
            at.node.children.splice(index, 0, structuredClone(op.node));
            return { changed: true, inverse: { kind: "delete", line: [...op.line] } };
        }
        case "promote": {
            const at = find(root, op.line);
            if (!at || !at.parent || at.index === 0) return none;
            const previous = at.parent.children[0].san!;
            at.parent.children.splice(at.index, 1);
            at.parent.children.unshift(at.node);
            return {
                changed: true,
                inverse: { kind: "promote", line: [...op.line.slice(0, -1), previous] },
            };
        }
        case "comment": {
            const at = find(root, op.line);
            if (!at) return none;
            const text = op.text.replace(/[{}]/g, "").trim();
            if (at.node.comment === text) return none;
            const old = at.node.comment;
            at.node.comment = text;
            return { changed: true, inverse: { kind: "comment", line: [...op.line], text: old } };
        }
        case "nags": {
            const at = find(root, op.line);
            if (!at || op.line.length === 0) return none;
            const old = at.node.annotations.filter((a) => isBasicAnnotation(a));
            const wanted = MOVE_SYMBOLS.filter((a) => op.nags.includes(a));
            if (old.length === wanted.length && old.every((a) => wanted.includes(a))) return none;
            const others = at.node.annotations.filter((a) => !isBasicAnnotation(a));
            at.node.annotations = [...wanted, ...others];
            return { changed: true, inverse: { kind: "nags", line: [...op.line], nags: old } };
        }
    }
}

function playSan(parent: TreeNode, san: string): TreeNode | null {
    // innerParsePGN does the move, the FEN and the number exactly as the desktop does.
    const tree = innerParsePGN([{ type: "San", value: san }], parent.fen, parent.halfMoves);
    const child = tree.root.children[0];
    return child ?? null;
}

// ---------------------------------------------------------------------------
// Reading and writing a game of a PGN file
// ---------------------------------------------------------------------------

const GLYPHS: Record<string, string> = {
    "!": "$1",
    "?": "$2",
    "!!": "$3",
    "??": "$4",
    "!?": "$5",
    "?!": "$6",
};

/** Tokens of a game as the desktop's lexer (pgn-reader) gives them. */
export function lexGame(text: string): Token[] {
    const tokens: Token[] = [];
    for (const tok of tokenize(text)) {
        switch (tok.kind) {
            case "header": {
                const m = /^\[(\w+)\s+"((?:[^"\\]|\\.)*)"\s*\]$/.exec(tok.text);
                if (m) {
                    tokens.push({
                        type: "Header",
                        value: { tag: m[1], value: m[2].replace(/\\(.)/g, "$1") },
                    });
                }
                break;
            }
            case "comment":
                // Line comments (";") are not kept by the desktop either.
                if (tok.text.startsWith("{")) {
                    const closed = tok.text.endsWith("}") && tok.text.length > 1;
                    tokens.push({
                        type: "Comment",
                        value: tok.text.slice(1, closed ? -1 : undefined),
                    });
                }
                break;
            case "open":
                tokens.push({ type: "ParenOpen" });
                break;
            case "close":
                tokens.push({ type: "ParenClose" });
                break;
            case "nag":
                tokens.push({ type: "Nag", value: GLYPHS[tok.text] ?? tok.text });
                break;
            case "result":
                tokens.push({ type: "Outcome", value: tok.text });
                break;
            case "san": {
                const m = /^(.*?)([!?]+)$/.exec(tok.text);
                if (m && m[1]) {
                    tokens.push({ type: "San", value: m[1] });
                    if (GLYPHS[m[2]]) tokens.push({ type: "Nag", value: GLYPHS[m[2]] });
                } else {
                    tokens.push({ type: "San", value: tok.text });
                }
                break;
            }
        }
    }
    return tokens;
}

type GameSpan = {
    /** First character of the game (its first header, or its movetext). */
    start: number;
    /** Where the movetext starts (= end of the headers when there is none). */
    movetextStart: number;
    /** End of the game (after its result, if any). */
    end: number;
    headers: Map<string, string>;
    /** Result token of the game ("*" when missing). */
    result: string;
    hasMovetext: boolean;
};

/** Where each game of a PGN file is (same numbering as the parsers). */
export function gameSpans(text: string): GameSpan[] {
    const tokens = tokenize(text);
    const spans: GameSpan[] = [];
    let cur: GameSpan | null = null;
    let inMoves = false;
    let depth = 0;
    const close = (end: number) => {
        if (cur) {
            cur.end = end;
            if (!cur.hasMovetext) cur.movetextStart = end;
            spans.push(cur);
        }
        cur = null;
        inMoves = false;
        depth = 0;
    };
    let lastEnd = 0;
    for (const tok of tokens) {
        if (tok.kind === "header") {
            if (inMoves) close(lastEnd);
            if (!cur) {
                cur = {
                    start: tok.start,
                    movetextStart: tok.end,
                    end: tok.end,
                    headers: new Map(),
                    result: "*",
                    hasMovetext: false,
                };
            }
            const m = /^\[(\w+)\s+"((?:[^"\\]|\\.)*)"\s*\]$/.exec(tok.text);
            if (m) cur.headers.set(m[1], m[2].replace(/\\(.)/g, "$1"));
            cur.movetextStart = tok.end;
            lastEnd = tok.end;
            continue;
        }
        if (!cur) {
            cur = {
                start: tok.start,
                movetextStart: tok.start,
                end: tok.end,
                headers: new Map(),
                result: "*",
                hasMovetext: false,
            };
        }
        const game = cur as GameSpan;
        if (!inMoves) {
            inMoves = true;
            if (tok.kind !== "result" || depth > 0) {
                game.movetextStart = tok.start;
                game.hasMovetext = true;
            }
        }
        if (tok.kind === "open") depth++;
        else if (tok.kind === "close") depth = Math.max(0, depth - 1);
        lastEnd = tok.end;
        if (tok.kind === "result" && depth === 0) {
            game.result = tok.text;
            if (!game.hasMovetext) {
                game.movetextStart = tok.start;
                game.hasMovetext = true;
            }
            close(tok.end);
        }
    }
    if (cur) close(lastEnd);
    return spans;
}

/** The tree of game `game` of a PGN file, as the desktop reads it. */
export function readGame(text: string, game: number): { root: TreeNode; span: GameSpan } | null {
    const span = gameSpans(text)[game];
    if (!span) return null;
    const fen = (span.headers.get("FEN") ?? INITIAL_FEN).trim();
    const tokens = lexGame(text.slice(span.movetextStart, span.end));
    try {
        return { root: innerParsePGN(tokens, fen).root, span };
    } catch {
        return null;
    }
}

/** Movetext of a game tree, written as the desktop writes it (result included). */
export function writeMovetext(root: TreeNode, result: string): string {
    let body = getPGN(root, {
        headers: null,
        comments: true,
        extraMarkups: true,
        glyphs: true,
        variations: true,
    });
    // The setup headers getPGN adds for another start position are already in the file.
    body = body.replace(/^\[SetUp "1"\]\n\[FEN "[^"]*"\]\n/, "").trim();
    return body ? `${body} ${result}` : result;
}

/**
 * Applies `op` to game `game` of the PGN file `text`. Returns the new text (the same
 * string when nothing changed) and the inverse edit.
 */
export function applyOp(
    text: string,
    game: number,
    op: RepertoireOp,
): { text: string; changed: boolean; inverse: RepertoireOp | null } {
    const read = readGame(text, game);
    if (!read) return { text, changed: false, inverse: null };
    const { changed, inverse } = applyOpToTree(read.root, op);
    if (!changed) return { text, changed: false, inverse: null };
    const { span } = read;
    const movetext = writeMovetext(read.root, span.result);
    const before = text.slice(0, span.movetextStart);
    const after = text.slice(span.end);
    const glue = span.hasMovetext
        ? ""
        : before.endsWith("\n\n")
          ? ""
          : before.endsWith("\n")
            ? "\n"
            : "\n\n";
    return { text: before + glue + movetext + after, changed: true, inverse };
}

/** The lines (SAN) of the moves after `line`, main first. */
export function continuations(root: TreeNode, line: readonly string[]): string[] {
    const at = find(root, line);
    return at ? at.node.children.map((c) => c.san!) : [];
}

export function nodeAt(root: TreeNode, line: readonly string[]): TreeNode | null {
    return find(root, line)?.node ?? null;
}

/** Number of moves in a subtree (the move itself included). */
export function countMoves(node: TreeNode): number {
    let n = node.san ? 1 : 0;
    for (const c of node.children) n += countMoves(c);
    return n;
}

export type { PgnToken };
