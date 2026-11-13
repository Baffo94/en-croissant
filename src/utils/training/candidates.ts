// "Candidate moves": critical moments of your analysed games (also the ones you played
// well), where you list the moves you would consider before the engine says its own.

import { Chess } from "chessops/chess";
import { makeFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import type { StatsGame } from "@/utils/accountStats";
import { BLUNDER, type GameEval, INACCURACY, MISTAKE, winChance } from "@/utils/gameReview";

export type MomentKind =
    /** The opponent had just erred and you found the punishment. */
    | "punished"
    /** The opponent had just erred and you let it go. */
    | "missed"
    /** A balanced position where your move lost ground. */
    | "turning";

export type Moment = {
    /** "<game id>#<ply index>". */
    id: string;
    /** Position before your move. */
    fen: string;
    color: "white" | "black";
    kind: MomentKind;
    /** The engine's move in the game analysis (SAN). */
    best: string;
    /** What you played, and the evaluations (your point of view, centipawns). */
    played: string;
    evalBefore: number;
    evalPlayed: number;
    moveLabel: string;
    url: string;
    opponent: string;
    date: number;
};

/** First ply looked at: the opening is the repertoire's job. */
export const FIRST_PLY = 16;
/** Positions already decided are not "critical". */
const DECIDED = 500;

export function buildMoments(
    games: readonly StatsGame[],
    evals: Record<string, GameEval>,
): Moment[] {
    const byFen = new Map<string, Moment>();
    for (const game of games) {
        const ev = evals[game.id];
        if (!ev) continue;
        const sans = game.moves ? game.moves.split(" ") : [];
        const me = game.color === "white" ? 1 : -1;
        const pos = Chess.default();
        for (let k = 0; k < sans.length; k++) {
            const mine = (k % 2 === 0) === (game.color === "white");
            if (mine && k >= FIRST_PLY) {
                const prev = ev.evals[k - 1];
                const before = ev.evals[k];
                const after = ev.evals[k + 1];
                const best = ev.best[k];
                if (
                    prev != null &&
                    before != null &&
                    after != null &&
                    best &&
                    parseSan(pos, best)
                ) {
                    const p = prev * me;
                    const b = before * me;
                    const a = after * me;
                    const gift = winChance(b) - winChance(p) > MISTAKE;
                    const drop = winChance(b) - winChance(a);
                    let kind: MomentKind | null = null;
                    if (gift) kind = drop <= INACCURACY ? "punished" : "missed";
                    else if (Math.abs(b) <= DECIDED && drop > INACCURACY && drop <= BLUNDER)
                        kind = "turning";
                    if (kind) {
                        const n = Math.floor(k / 2) + 1;
                        const fen = makeFen(pos.toSetup());
                        const moment: Moment = {
                            id: `${game.id}#${k}`,
                            fen,
                            color: game.color,
                            kind,
                            best,
                            played: sans[k],
                            evalBefore: b,
                            evalPlayed: a,
                            moveLabel: k % 2 === 0 ? `${n}.` : `${n}...`,
                            url: game.url,
                            opponent: game.opponent,
                            date: game.end,
                        };
                        const key = fen.split(" ").slice(0, 4).join(" ");
                        const known = byFen.get(key);
                        if (!known || known.date < moment.date) byFen.set(key, moment);
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

export type CandidateVerdict = "best" | "good" | "inaccuracy" | "mistake" | "blunder";

/** How a candidate compares with the engine's best move (both scores from your side). */
export function judgeCandidate(bestCp: number, cp: number, isBest: boolean): CandidateVerdict {
    if (isBest) return "best";
    const drop = winChance(bestCp) - winChance(cp);
    if (drop <= INACCURACY) return "good";
    if (drop <= MISTAKE) return "inaccuracy";
    if (drop <= BLUNDER) return "mistake";
    return "blunder";
}

/** One solved "candidate moves" exercise, kept on the PC. */
export type CandidateAttempt = {
    id: string;
    at: string;
    /** Your candidates (UCI); the first one is the move you would play. */
    candidates: string[];
    /** Was the engine's best move among them? */
    foundBest: boolean;
    /** Verdict on the move you would play. */
    choice: CandidateVerdict;
};

export type CandidateSummary = {
    done: number;
    /** Share of exercises where the best move was among your candidates. */
    foundBest: number | null;
    /** Share of exercises where your choice was at least "good". */
    goodChoice: number | null;
};

export function summarizeAttempts(history: readonly CandidateAttempt[]): CandidateSummary {
    const done = history.length;
    if (!done) return { done, foundBest: null, goodChoice: null };
    const found = history.filter((a) => a.foundBest).length;
    const good = history.filter((a) => a.choice === "best" || a.choice === "good").length;
    return { done, foundBest: found / done, goodChoice: good / done };
}
