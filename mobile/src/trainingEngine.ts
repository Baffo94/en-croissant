// The phone's Stockfish, used by the tactics to judge a move that is not the engine's
// own one from the game analysis.

import { positionFromFen } from "@/utils/chessops";
import { CP_CEILING } from "@/utils/gameReview";
import { Engine, type Score } from "./engine";

let engine: Engine | null = null;

/** Centipawns from White's point of view, mates as ±1000 (like the PC's analysis). */
export function scoreCp(score: Score): number {
    if (score.type === "mate") return score.value >= 0 ? CP_CEILING : -CP_CEILING;
    return Math.max(-CP_CEILING, Math.min(CP_CEILING, score.value));
}

/**
 * Evaluates the position after a move, from the point of view of the side that moved
 * (`mover`). Game over on the board needs no engine.
 */
export function evaluateAfter(fen: string, mover: "white" | "black", depth = 14): Promise<number> {
    const [pos] = positionFromFen(fen);
    const sign = mover === "white" ? 1 : -1;
    if (pos?.isCheckmate()) return Promise.resolve(CP_CEILING);
    if (pos && (pos.isStalemate() || pos.isInsufficientMaterial())) return Promise.resolve(0);
    engine ??= new Engine();
    const current = engine;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Il motore non risponde.")), 30_000);
        void current.analyse(
            fen,
            (a) => {
                if (!a.done) return;
                clearTimeout(timer);
                const best = a.lines[0];
                if (!best) reject(new Error("Nessuna valutazione."));
                else resolve(scoreCp(best.score) * sign);
            },
            { multiPv: 1, depth },
        );
    });
}

export function stopTrainingEngine() {
    engine?.destroy();
    engine = null;
}
