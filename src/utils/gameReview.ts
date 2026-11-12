// Phase 2 of the statistics: what the engine says about the account's games.
// Errors (by phase and in time trouble), conversion of winning positions, endgames
// and the evaluation when leaving the opening (after move 15).

import { Chess } from "chessops/chess";
import { makeUci } from "chessops";
import { parseSan } from "chessops/san";
import type { GameResult, StatsGame } from "./accountStats";

/** Engine evaluations stored for one game. */
export type GameEval = {
    /** Centipawns from White's point of view for each position (start + after each move), ±1000 at most; null when not analysed. */
    evals: (number | null)[];
    /** Engine's best move (SAN) in each position ("" when none). */
    best: string[];
    /** Index of the first position of the endgame, null if the game never got there. */
    endgameFrom: number | null;
};

export const CP_CEILING = 1000;
/** Thresholds of the app's game report (drop of winning chances, in %). */
export const INACCURACY = 5;
export const MISTAKE = 10;
export const BLUNDER = 20;
/** Clear advantage, for conversion and comebacks (centipawns). */
export const CLEAR_ADVANTAGE = 200;
/** Endgame: at most this many queens, rooks, bishops and knights left on the board. */
export const ENDGAME_PIECES = 6;
/** Opening phase: the first 15 moves (unless the endgame starts earlier). */
export const OPENING_PLIES = 30;
/** Time trouble: less than this share of the starting time on the clock. */
export const TIME_TROUBLE_SHARE = 0.1;

export function winChance(cp: number) {
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export function clampCp(score: { type: "cp" | "mate" | string; value: number }) {
    if (score.type === "mate") return score.value === 0 ? 0 : Math.sign(score.value) * CP_CEILING;
    return Math.max(-CP_CEILING, Math.min(CP_CEILING, score.value));
}

/** UCI moves of a game (stored as SAN); stops at the first move that cannot be read. */
export function uciMoves(game: StatsGame): string[] {
    const pos = Chess.default();
    const out: string[] = [];
    for (const san of game.moves ? game.moves.split(" ") : []) {
        const move = parseSan(pos, san);
        if (!move) break;
        out.push(makeUci(move));
        pos.play(move);
    }
    return out;
}

/** Index of the first position with at most ENDGAME_PIECES pieces (pawns and kings apart). */
export function endgameStart(game: StatsGame): number | null {
    const pos = Chess.default();
    const pieces = () =>
        pos.board.knight
            .union(pos.board.bishop)
            .union(pos.board.rook)
            .union(pos.board.queen)
            .size();
    if (pieces() <= ENDGAME_PIECES) return 0;
    let i = 0;
    for (const san of game.moves ? game.moves.split(" ") : []) {
        const move = parseSan(pos, san);
        if (!move) break;
        pos.play(move);
        i++;
        if (pieces() <= ENDGAME_PIECES) return i;
    }
    return null;
}

type AnalysedPosition = {
    best: { score: { value: { type: string; value: number } }; sanMoves: string[] }[];
};

/** Turns the result of the engine (one entry per non-final position) into a GameEval. */
export function gameEvalOf(game: StatsGame, analysis: AnalysedPosition[]): GameEval {
    const plies = game.moves ? game.moves.split(" ").length : 0;
    const evals: (number | null)[] = [];
    const best: string[] = [];
    for (let i = 0; i <= plies; i++) {
        const top = analysis[i]?.best[0];
        evals.push(top ? clampCp(top.score.value) : null);
        best.push(top?.sanMoves[0] ?? "");
    }
    // The final position is not analysed when the game is over on the board.
    if (evals[plies] === null) {
        if (game.ending === "mate") {
            const whiteWon = (game.result === "win") === (game.color === "white");
            evals[plies] = whiteWon ? CP_CEILING : -CP_CEILING;
        } else if (["stalemate", "insufficient", "repetition", "fifty"].includes(game.ending)) {
            evals[plies] = 0;
        }
    }
    return { evals, best, endgameFrom: endgameStart(game) };
}

// ---------------------------------------------------------------- One game

export type Phase = "opening" | "middlegame" | "endgame";
export const PHASES: Phase[] = ["opening", "middlegame", "endgame"];

export type PhaseCount = {
    moves: number;
    inaccuracies: number;
    mistakes: number;
    blunders: number;
};

export type BigError = {
    gameId: string;
    url: string;
    /** Move number and side, e.g. "23." or "23…". */
    moveLabel: string;
    played: string;
    best: string;
    drop: number;
    before: number;
    after: number;
    phase: Phase;
    end: number;
};

export type GameReview = {
    game: StatsGame;
    moves: number;
    accuracy: number | null;
    phases: Record<Phase, PhaseCount>;
    /** Mistakes and blunders made in time trouble / with clock information. */
    seriousInTrouble: number;
    seriousWithClock: number;
    movesInTrouble: number;
    movesWithClock: number;
    /** Had a clear advantage (two positions in a row at +2 or more). */
    winning: boolean;
    /** Had a clear disadvantage (two positions in a row at -2 or less). */
    losing: boolean;
    /** Evaluation (your point of view) after move 15, null if the game was shorter. */
    eval15: number | null;
    /** Evaluation (your point of view) when the endgame started. */
    endgameEval: number | null;
    endgame: PhaseCount | null;
    errors: BigError[];
};

function baseSeconds(timeControl: string): number | null {
    const base = Number(timeControl.split("+")[0]);
    return Number.isFinite(base) && base > 0 ? base : null;
}

const emptyPhase = (): PhaseCount => ({ moves: 0, inaccuracies: 0, mistakes: 0, blunders: 0 });

export function reviewGame(game: StatsGame, ev: GameEval): GameReview {
    const me = game.color === "white" ? 1 : -1;
    const mine = (cp: number) => cp * me;
    const sans = game.moves ? game.moves.split(" ") : [];
    const phases: Record<Phase, PhaseCount> = {
        opening: emptyPhase(),
        middlegame: emptyPhase(),
        endgame: emptyPhase(),
    };
    const base = baseSeconds(game.timeControl);
    const trouble = base ? Math.max(base * TIME_TROUBLE_SHARE, 10) * 10 : null; // tenths
    let accSum = 0;
    let accN = 0;
    let seriousInTrouble = 0;
    let seriousWithClock = 0;
    let movesInTrouble = 0;
    let movesWithClock = 0;
    const errors: BigError[] = [];
    const firstMine = game.color === "white" ? 0 : 1;
    for (let k = firstMine; k < sans.length; k += 2) {
        const before = ev.evals[k];
        const after = ev.evals[k + 1];
        if (before == null || after == null) continue;
        const phase: Phase =
            ev.endgameFrom !== null && k >= ev.endgameFrom
                ? "endgame"
                : k < OPENING_PLIES
                  ? "opening"
                  : "middlegame";
        const drop = Math.max(0, winChance(mine(before)) - winChance(mine(after)));
        const p = phases[phase];
        p.moves++;
        const serious = drop > MISTAKE;
        if (drop > BLUNDER) p.blunders++;
        else if (drop > MISTAKE) p.mistakes++;
        else if (drop > INACCURACY) p.inaccuracies++;
        accSum += Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669 + 1));
        accN++;
        // Clock before the move: after your previous move (or the starting time).
        if (trouble !== null && game.clocks.length === sans.length) {
            const clock = k >= 2 ? game.clocks[k - 2] : (base as number) * 10;
            movesWithClock++;
            if (serious) seriousWithClock++;
            if (clock < trouble) {
                movesInTrouble++;
                if (serious) seriousInTrouble++;
            }
        }
        if (drop > MISTAKE) {
            const n = Math.floor(k / 2) + 1;
            errors.push({
                gameId: game.id,
                url: game.url,
                moveLabel: k % 2 === 0 ? `${n}.` : `${n}…`,
                played: sans[k],
                best: ev.best[k] ?? "",
                drop,
                before: mine(before),
                after: mine(after),
                phase,
                end: game.end,
            });
        }
    }
    const run = (test: (cp: number) => boolean) => {
        for (let i = 1; i + 1 < ev.evals.length; i++) {
            const a = ev.evals[i];
            const b = ev.evals[i + 1];
            if (a != null && b != null && test(mine(a)) && test(mine(b))) return true;
        }
        return false;
    };
    const at = (i: number | null) => {
        if (i === null || i >= ev.evals.length) return null;
        const v = ev.evals[i];
        return v == null ? null : mine(v);
    };
    return {
        game,
        moves: accN,
        accuracy: accN ? accSum / accN : null,
        phases,
        seriousInTrouble,
        seriousWithClock,
        movesInTrouble,
        movesWithClock,
        winning: run((cp) => cp >= CLEAR_ADVANTAGE),
        losing: run((cp) => cp <= -CLEAR_ADVANTAGE),
        eval15: sans.length > OPENING_PLIES ? at(OPENING_PLIES) : null,
        endgameEval:
            ev.endgameFrom !== null && ev.endgameFrom < sans.length ? at(ev.endgameFrom) : null,
        endgame: ev.endgameFrom !== null && ev.endgameFrom < sans.length ? phases.endgame : null,
        errors,
    };
}

// ---------------------------------------------------------------- Period

export type Outcomes = { n: number; wins: number; draws: number; losses: number };

export type EngineStats = {
    /** Games of the period and how many of them have been analysed. */
    total: number;
    analysed: number;
    accuracy: number | null;
    perGame: { inaccuracies: number; mistakes: number; blunders: number } | null;
    phases: Record<Phase, PhaseCount>;
    timeTrouble: {
        seriousInTrouble: number;
        seriousWithClock: number;
        movesInTrouble: number;
        movesWithClock: number;
    };
    conversion: Outcomes;
    comebacks: Outcomes;
    endgames: { n: number; score: number; expected: number; errors: PhaseCount };
    eval15: {
        white: { n: number; avg: number | null };
        black: { n: number; avg: number | null };
        better: number;
        equal: number;
        worse: number;
    };
    /** Average evaluation after move 15 by "color|opening family". */
    eval15ByOpening: Map<string, { n: number; avg: number }>;
    errors: BigError[];
};

const points = (r: GameResult) => (r === "win" ? 1 : r === "draw" ? 0.5 : 0);

function outcomes(reviews: GameReview[]): Outcomes {
    const o = { n: reviews.length, wins: 0, draws: 0, losses: 0 };
    for (const r of reviews) {
        if (r.game.result === "win") o.wins++;
        else if (r.game.result === "draw") o.draws++;
        else o.losses++;
    }
    return o;
}

export function engineStats(
    games: StatsGame[],
    evals: Record<string, GameEval>,
    familyOf: (g: StatsGame) => string,
): EngineStats {
    const reviews = games.filter((g) => evals[g.id]).map((g) => reviewGame(g, evals[g.id]));
    const phases: Record<Phase, PhaseCount> = {
        opening: emptyPhase(),
        middlegame: emptyPhase(),
        endgame: emptyPhase(),
    };
    const tt = { seriousInTrouble: 0, seriousWithClock: 0, movesInTrouble: 0, movesWithClock: 0 };
    let accSum = 0;
    let accN = 0;
    for (const r of reviews) {
        for (const p of PHASES) {
            phases[p].moves += r.phases[p].moves;
            phases[p].inaccuracies += r.phases[p].inaccuracies;
            phases[p].mistakes += r.phases[p].mistakes;
            phases[p].blunders += r.phases[p].blunders;
        }
        tt.seriousInTrouble += r.seriousInTrouble;
        tt.seriousWithClock += r.seriousWithClock;
        tt.movesInTrouble += r.movesInTrouble;
        tt.movesWithClock += r.movesWithClock;
        if (r.accuracy !== null) {
            accSum += r.accuracy;
            accN++;
        }
    }
    const sum = (f: (p: PhaseCount) => number) => PHASES.reduce((s, p) => s + f(phases[p]), 0);
    const endgameReviews = reviews.filter((r) => r.endgameEval !== null);
    const endgameErrors = emptyPhase();
    for (const r of endgameReviews) {
        if (!r.endgame) continue;
        endgameErrors.moves += r.endgame.moves;
        endgameErrors.inaccuracies += r.endgame.inaccuracies;
        endgameErrors.mistakes += r.endgame.mistakes;
        endgameErrors.blunders += r.endgame.blunders;
    }
    const with15 = reviews.filter((r) => r.eval15 !== null);
    const avg = (rs: GameReview[]) =>
        rs.length ? rs.reduce((s, r) => s + (r.eval15 as number), 0) / rs.length : null;
    const byOpening = new Map<string, { n: number; avg: number }>();
    const groups = new Map<string, GameReview[]>();
    for (const r of with15) {
        const key = `${r.game.color}|${familyOf(r.game)}`;
        const l = groups.get(key);
        if (l) l.push(r);
        else groups.set(key, [r]);
    }
    for (const [key, rs] of groups) byOpening.set(key, { n: rs.length, avg: avg(rs) as number });
    const white15 = with15.filter((r) => r.game.color === "white");
    const black15 = with15.filter((r) => r.game.color === "black");
    return {
        total: games.length,
        analysed: reviews.length,
        accuracy: accN ? accSum / accN : null,
        perGame: reviews.length
            ? {
                  inaccuracies: sum((p) => p.inaccuracies) / reviews.length,
                  mistakes: sum((p) => p.mistakes) / reviews.length,
                  blunders: sum((p) => p.blunders) / reviews.length,
              }
            : null,
        phases,
        timeTrouble: tt,
        conversion: outcomes(reviews.filter((r) => r.winning)),
        comebacks: outcomes(reviews.filter((r) => r.losing)),
        endgames: {
            n: endgameReviews.length,
            score: endgameReviews.reduce((s, r) => s + points(r.game.result), 0),
            expected: endgameReviews.reduce(
                (s, r) => s + winChance(r.endgameEval as number) / 100,
                0,
            ),
            errors: endgameErrors,
        },
        eval15: {
            white: { n: white15.length, avg: avg(white15) },
            black: { n: black15.length, avg: avg(black15) },
            better: with15.filter((r) => (r.eval15 as number) >= 100).length,
            equal: with15.filter((r) => Math.abs(r.eval15 as number) < 100).length,
            worse: with15.filter((r) => (r.eval15 as number) <= -100).length,
        },
        eval15ByOpening: byOpening,
        errors: reviews
            .flatMap((r) => r.errors)
            .sort((a, b) => b.drop - a.drop || b.end - a.end)
            .slice(0, 15),
    };
}

/** Serious errors (mistakes and blunders) per 100 moves of a phase. */
export function seriousRate(p: PhaseCount): number | null {
    return p.moves ? ((p.mistakes + p.blunders) / p.moves) * 100 : null;
}
