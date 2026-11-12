// Helpers for the local database of opening evaluations (src-tauri/src/evalcache.rs).

import { parseUci } from "chessops";
import { makeFen } from "chessops/fen";
import { getDefaultStore } from "jotai";
import type { BestMoves, CachedEval } from "@/bindings";
import { evalCacheSettingsAtom } from "@/state/atoms";
import { positionFromFen } from "./chessops";

/** Only positions up to this move number are kept (as in the Rust side). */
export const MAX_FULLMOVE = 20;
/** Evaluations shallower than this are not worth storing. */
export const MIN_STORED_DEPTH = 20;

export function evalCacheSettings() {
    return getDefaultStore().get(evalCacheSettingsAtom);
}

/** FEN reached from `fen` with UCI `moves` (null if a move is not legal). */
export function fenAfter(fen: string, moves: string[]): string | null {
    const [pos, error] = positionFromFen(fen);
    if (error || !pos) return null;
    for (const uci of moves) {
        const move = parseUci(uci);
        if (!move || !pos.isLegal(move)) return null;
        pos.play(move);
    }
    return makeFen(pos.toSetup());
}

export function isOpeningFen(fen: string): boolean {
    return (Number(fen.split(" ")[5]) || 1) <= MAX_FULLMOVE;
}

/** Stored lines as the engine gives them (scores from White's point of view). */
/** Lines shown from the database, with where they came from ("lichess" or an engine). */
const storedSources = new WeakMap<BestMoves[], { source: string; depth: number }>();

/** Where the lines on screen came from, when they are a stored evaluation. */
export function storedSource(lines: BestMoves[] | undefined) {
    return lines ? storedSources.get(lines) : undefined;
}

/** Readable name of a stored evaluation's source. */
export function sourceLabel(source: string) {
    return source === "lichess" ? "Lichess" : source;
}

export function toBestMoves(stored: CachedEval): BestMoves[] {
    const lines = toBestMovesLines(stored);
    storedSources.set(lines, { source: stored.source, depth: stored.depth });
    return lines;
}

function toBestMovesLines(stored: CachedEval): BestMoves[] {
    return stored.lines.map((l) => ({
        nodes: 0,
        depth: l.depth,
        score: {
            value:
                l.mate !== null
                    ? { type: "mate", value: l.mate }
                    : { type: "cp", value: l.cp ?? 0 },
            wdl: null,
        },
        uciMoves: l.uciMoves,
        sanMoves: l.sanMoves,
        multipv: l.multipv,
        nps: 0,
    }));
}

export function fromBestMoves(lines: BestMoves[], source: string): CachedEval {
    return {
        depth: Math.min(...lines.map((l) => l.depth)),
        source,
        lichessChecked: false,
        lines: lines.map((l) => ({
            uciMoves: l.uciMoves,
            sanMoves: l.sanMoves,
            cp: l.score.value.type === "cp" ? l.score.value.value : null,
            mate: l.score.value.type === "mate" ? l.score.value.value : null,
            depth: l.depth,
            multipv: l.multipv,
        })),
    };
}
