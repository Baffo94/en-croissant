// Tactics from your own games: the positions of your analysed games where you made a
// mistake (or did not punish one), to find the move the engine wanted.

import { makeUci } from "chessops";
import { Chess } from "chessops/chess";
import { makeFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import type { StatsGame } from "@/utils/accountStats";
import { type GameEval, INACCURACY, MISTAKE, winChance } from "@/utils/gameReview";

export type Tactic = {
    /** "<game id>#<ply index>": stable, so progress survives a rebuild of the pack. */
    id: string;
    /** Position before your move. */
    fen: string;
    color: "white" | "black";
    /** The engine's move (SAN and UCI). */
    best: string;
    bestUci: string;
    /** What you played. */
    played: string;
    /** Evaluations from your point of view (centipawns, ±1000 at most). */
    evalBest: number;
    evalPlayed: number;
    /** "missed": the opponent had just erred and you did not punish it. */
    kind: "error" | "missed";
    moveLabel: string;
    url: string;
    opponent: string;
    /** End of the game (ms). */
    date: number;
};

/** Win-chance points a move may lose against the engine's and still count as right. */
export const ACCEPT_DROP = INACCURACY;

/** True when a move evaluated `answerCp` is as good as the engine's (`bestCp`), both from your side. */
export function isGoodAnswer(bestCp: number, answerCp: number): boolean {
    return winChance(bestCp) - winChance(answerCp) <= ACCEPT_DROP;
}

export function buildTactics(
    games: readonly StatsGame[],
    evals: Record<string, GameEval>,
): Tactic[] {
    const byFen = new Map<string, Tactic>();
    for (const game of games) {
        const ev = evals[game.id];
        if (!ev) continue;
        const sans = game.moves ? game.moves.split(" ") : [];
        const me = game.color === "white" ? 1 : -1;
        const pos = Chess.default();
        for (let k = 0; k < sans.length; k++) {
            const mine = (k % 2 === 0) === (game.color === "white");
            if (mine) {
                const before = ev.evals[k];
                const after = ev.evals[k + 1];
                const best = ev.best[k];
                if (before != null && after != null && best && best !== sans[k]) {
                    const bestCp = before * me;
                    const playedCp = after * me;
                    const drop = winChance(bestCp) - winChance(playedCp);
                    const bestMove = parseSan(pos, best);
                    if (drop > MISTAKE && bestMove) {
                        const prev = k > 0 ? ev.evals[k - 1] : null;
                        const gift =
                            prev != null && winChance(bestCp) - winChance(prev * me) > MISTAKE;
                        const n = Math.floor(k / 2) + 1;
                        const fen = makeFen(pos.toSetup());
                        const tactic: Tactic = {
                            id: `${game.id}#${k}`,
                            fen,
                            color: game.color,
                            best,
                            bestUci: makeUci(bestMove),
                            played: sans[k],
                            evalBest: bestCp,
                            evalPlayed: playedCp,
                            kind: gift ? "missed" : "error",
                            moveLabel: k % 2 === 0 ? `${n}.` : `${n}...`,
                            url: game.url,
                            opponent: game.opponent,
                            date: game.end,
                        };
                        // The same position in several games: the most recent one.
                        const key = fen.split(" ").slice(0, 4).join(" ");
                        const known = byFen.get(key);
                        if (!known || known.date < tactic.date) byFen.set(key, tactic);
                    }
                }
            }
            const move = parseSan(pos, sans[k]);
            if (!move) break;
            pos.play(move);
        }
    }
    return [...byFen.values()].sort((a, b) => b.date - a.date || a.id.localeCompare(b.id));
}

export type TacticsPack = {
    version: 1;
    /** When the PC built it (ISO). */
    built: string;
    tactics: Tactic[];
};

export const TACTICS_PACK_PATH = "training/tactics.json";
export const TRAINING_PROGRESS_PATH = "training/progress.json";
