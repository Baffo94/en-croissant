// Edits the comment of one move directly in the PGN text, leaving every other byte of
// the file as it is (moves, variations, NAGs, other comments, arrows, evaluations).
// Used by the phone, which has no PGN writer of its own: rewriting the whole file
// could lose details the desktop wrote.

import { INITIAL_FEN, makeFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { positionFromFen } from "./chessops";

type Token = {
    kind: "header" | "comment" | "open" | "close" | "nag" | "number" | "result" | "san" | "other";
    start: number;
    end: number;
    text: string;
};

function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    let lineStart = true;
    const push = (kind: Token["kind"], start: number, end: number) =>
        tokens.push({ kind, start, end, text: text.slice(start, end) });
    while (i < text.length) {
        const c = text[i];
        if (c === "\n") {
            lineStart = true;
            i++;
            continue;
        }
        if (c === " " || c === "\t" || c === "\r") {
            i++;
            continue;
        }
        if (lineStart && c === "%") {
            // Escape line: ignored up to the end of the line.
            const end = text.indexOf("\n", i);
            i = end < 0 ? text.length : end;
            continue;
        }
        const atLineStart = lineStart;
        lineStart = false;
        if (c === "[" && atLineStart) {
            // Header: up to the last "]" of the line (values can contain "]": [Start "[0]"]).
            const eol = text.indexOf("\n", i);
            const lineEnd = eol < 0 ? text.length : eol;
            const end = text.lastIndexOf("]", lineEnd);
            const stop = end < i ? lineEnd : end + 1;
            push("header", i, stop);
            i = stop;
        } else if (c === "{") {
            const end = text.indexOf("}", i);
            const stop = end < 0 ? text.length : end + 1;
            push("comment", i, stop);
            i = stop;
        } else if (c === ";") {
            const end = text.indexOf("\n", i);
            const stop = end < 0 ? text.length : end;
            push("comment", i, stop);
            i = stop;
        } else if (c === "(") {
            push("open", i, i + 1);
            i++;
        } else if (c === ")") {
            push("close", i, i + 1);
            i++;
        } else {
            let j = i;
            while (j < text.length && !/[\s{}();[\]]/.test(text[j])) j++;
            if (j === i) j = i + 1;
            const word = text.slice(i, j);
            let kind: Token["kind"];
            if (/^\$\d+$/.test(word)) kind = "nag";
            else if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(word)) kind = "result";
            else if (/^\d+\.*$/.test(word)) kind = "number";
            else if (/^\d+\.+\S/.test(word)) {
                // "12.Nf3": number glued to the move.
                const dots = word.match(/^\d+\.+/)![0].length;
                push("number", i, i + dots);
                push("san", i + dots, j);
                i = j;
                continue;
            } else if (/^[!?]+$/.test(word)) kind = "nag";
            else kind = "san";
            push(kind, i, j);
            i = j;
        }
    }
    return tokens;
}

/**
 * Finds the move reached by `line` (SAN moves from the start of game `game`, as the
 * phone's parser writes them) and returns the token index of its SAN.
 */
function locate(tokens: Token[], game: number, line: readonly string[]): number | null {
    const target = line.join(" ");
    let gameIndex = 0;
    let inMoves = false;
    let headers = new Map<string, string>();
    type Frame = { path: string[]; fen: string; prevPath: string[]; prevFen: string };
    let stack: Frame[] = [];
    let cur: Frame | null = null;

    const startGame = () => {
        const fen = (headers.get("FEN") ?? INITIAL_FEN).trim();
        cur = { path: [], fen, prevPath: [], prevFen: fen };
        stack = [];
        inMoves = true;
    };

    for (let t = 0; t < tokens.length; t++) {
        const tok = tokens[t];
        if (tok.kind === "header") {
            if (inMoves) {
                // A new game without a result token.
                gameIndex++;
                inMoves = false;
                headers = new Map();
            }
            const m = /^\[(\w+)\s+"(.*)"\]$/.exec(tok.text);
            if (m) headers.set(m[1], m[2]);
            continue;
        }
        if (tok.kind === "result") {
            if (stack.length === 0) {
                if (!inMoves) startGame();
                gameIndex++;
                inMoves = false;
                headers = new Map();
            }
            continue;
        }
        if (!inMoves) startGame();
        if (gameIndex !== game) continue;
        const frame = cur as unknown as Frame;
        if (tok.kind === "open") {
            stack.push({ ...frame });
            // The variation replaces the last move: continue from before it.
            cur = {
                path: frame.prevPath,
                fen: frame.prevFen,
                prevPath: frame.prevPath,
                prevFen: frame.prevFen,
            };
            continue;
        }
        if (tok.kind === "close") {
            cur = stack.pop() ?? frame;
            continue;
        }
        if (tok.kind !== "san") continue;
        const [pos, error] = positionFromFen(frame.fen);
        if (error || !pos) continue;
        const move = parseSan(pos, tok.text.replace(/[!?]+$/, ""));
        if (!move) continue; // like the parsers: an unreadable move is skipped
        const san = makeSan(pos, move);
        pos.play(move);
        const path = [...frame.path, san];
        cur = { path, fen: makeFen(pos.toSetup()), prevPath: frame.path, prevFen: frame.fen };
        if (path.join(" ") === target) return t;
    }
    return null;
}

/**
 * Token index where the movetext of game `game` starts (its first comment, move number,
 * move or result), or null when the game has no movetext.
 */
function locateStart(tokens: Token[], game: number): number | null {
    let gameIndex = 0;
    let inMoves = false;
    let depth = 0;
    for (let t = 0; t < tokens.length; t++) {
        const tok = tokens[t];
        if (tok.kind === "header") {
            if (inMoves) {
                gameIndex++;
                inMoves = false;
                depth = 0;
            }
            continue;
        }
        if (!inMoves) {
            if (gameIndex === game) return t;
            inMoves = true;
        }
        if (tok.kind === "open") depth++;
        else if (tok.kind === "close") depth = Math.max(0, depth - 1);
        else if (tok.kind === "result" && depth === 0) {
            gameIndex++;
            inMoves = false;
        }
    }
    return null;
}

const DIRECTIVE = /\[%[^\]]*\]/g;

/** Free text of a comment, without [%...] directives (as the parsers show it). */
function freeText(comment: string): string {
    return comment.replace(DIRECTIVE, "").trim();
}

/**
 * Sets the comment text of the move reached by `line` in game `game` (an empty `line`
 * means the game's own comment, before the first move). Directives
 * ([%cal], [%csl], [%eval], [%clk]...) already there are kept; an empty text removes
 * the comment when it has no directives. Returns null when the move is not found.
 */
export function setMoveComment(
    pgn: string,
    game: number,
    line: readonly string[],
    text: string,
): string | null {
    const tokens = tokenize(pgn);
    let first: number;
    if (line.length === 0) {
        // The game's own comment: the one before the first move.
        const start = locateStart(tokens, game);
        if (start === null) return null;
        first = start;
    } else {
        const at = locate(tokens, game, line);
        if (at === null) return null;
        // NAGs right after the move belong to it; then its comments.
        first = at + 1;
        while (first < tokens.length && tokens[first].kind === "nag") first++;
    }
    let k = first;
    const comments: Token[] = [];
    while (k < tokens.length && tokens[k].kind === "comment" && tokens[k].text.startsWith("{")) {
        comments.push(tokens[k]);
        k++;
    }
    const directives = comments.flatMap((c) => c.text.slice(1, -1).match(DIRECTIVE) ?? []);
    const clean = text.replace(/[{}]/g, "").trim();
    const body = [directives.join(""), clean].filter(Boolean).join(" ");
    const replacement = body ? `{${body}}` : "";
    if (comments.length > 0) {
        const start = comments[0].start;
        let end = comments[comments.length - 1].end;
        if (!replacement) {
            // Remove the comment and one following space.
            if (pgn[end] === " ") end++;
            return pgn.slice(0, start) + pgn.slice(end);
        }
        return pgn.slice(0, start) + replacement + pgn.slice(end);
    }
    if (!replacement) return pgn;
    if (line.length === 0) {
        const insertAt = tokens[first].start;
        return `${pgn.slice(0, insertAt)}${replacement} ${pgn.slice(insertAt)}`;
    }
    const insertAt = tokens[first - 1].end;
    return `${pgn.slice(0, insertAt)} ${replacement}${pgn.slice(insertAt)}`;
}

/** Current comment text (without directives) of a move, "" when none or not found. */
export function getMoveComment(pgn: string, game: number, line: readonly string[]): string {
    const tokens = tokenize(pgn);
    let k: number;
    if (line.length === 0) {
        const start = locateStart(tokens, game);
        if (start === null) return "";
        k = start;
    } else {
        const at = locate(tokens, game, line);
        if (at === null) return "";
        k = at + 1;
        while (k < tokens.length && tokens[k].kind === "nag") k++;
    }
    const texts: string[] = [];
    while (k < tokens.length && tokens[k].kind === "comment" && tokens[k].text.startsWith("{")) {
        texts.push(freeText(tokens[k].text.slice(1, -1)));
        k++;
    }
    return texts.filter(Boolean).join("\n");
}
