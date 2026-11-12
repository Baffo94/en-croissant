import { describe, expect, test } from "vitest";
import { type StatsGame, statsReport } from "../accountStats";
import {
    CP_CEILING,
    endgameStart,
    engineStats,
    type GameEval,
    gameEvalOf,
    reviewGame,
    uciMoves,
} from "../gameReview";

let counter = 0;
function game(over: Partial<StatsGame>): StatsGame {
    counter++;
    return {
        id: `g${counter}`,
        source: "chesscom",
        url: `https://chess.com/${counter}`,
        start: 0,
        end: 0,
        speed: "rapid",
        timeControl: "600",
        rated: true,
        color: "white",
        rating: 1500,
        oppRating: 1500,
        opponent: "x",
        result: "win",
        ending: "resign",
        moves: "e4 e5 Nf3 Nc6 Bc4 Nd4",
        clocks: [],
        opening: "Italian Game",
        ...over,
    };
}

const ev = (evals: (number | null)[], over: Partial<GameEval> = {}): GameEval => ({
    evals,
    best: evals.map(() => "d4"),
    endgameFrom: null,
    ...over,
});

describe("moves and phases", () => {
    test("converts SAN to UCI", () => {
        expect(uciMoves(game({ moves: "e4 e5 Nf3 Nc6 O-O" }))).toEqual([
            "e2e4",
            "e7e5",
            "g1f3",
            "b8c6",
        ]);
    });
    test("finds where the endgame starts", () => {
        expect(endgameStart(game({}))).toBeNull();
        expect(endgameStart(game({ moves: "" }))).toBeNull();
    });
    test("fills the final position from the result", () => {
        const g = game({ moves: "f3 e5 g4 Qh4#", color: "black", result: "win", ending: "mate" });
        const best = (cp: number) => ({
            best: [{ score: { value: { type: "cp", value: cp } }, sanMoves: ["x"] }],
        });
        const e = gameEvalOf(g, [best(0), best(-50), best(-200), best(-9000)]);
        expect(e.evals).toEqual([0, -50, -200, -CP_CEILING, -CP_CEILING]);
        const mate = gameEvalOf(g, [
            { best: [{ score: { value: { type: "mate", value: -3 } }, sanMoves: ["e5"] }] },
        ]);
        expect(mate.evals[0]).toBe(-CP_CEILING);
        expect(mate.best[0]).toBe("e5");
    });
});

describe("reviewGame", () => {
    test("classifies your moves, phases and time trouble", () => {
        const g = game({ clocks: [5900, 5900, 500, 5800, 400, 5700] });
        const r = reviewGame(g, ev([20, 25, 30, 30, 30, -300, -300]));
        expect(r.moves).toBe(3);
        expect(r.phases.opening).toMatchObject({ moves: 3, blunders: 1, mistakes: 0 });
        expect(r.errors).toHaveLength(1);
        expect(r.errors[0]).toMatchObject({
            moveLabel: "3.",
            played: "Bc4",
            best: "d4",
            before: 30,
            after: -300,
        });
        // Clock before Bc4 was 50 s (< 60 s = 10% of 10 minutes).
        expect(r.seriousInTrouble).toBe(1);
        expect(r.movesInTrouble).toBe(1);
        expect(r.movesWithClock).toBe(3);
        expect(r.losing).toBe(true);
        expect(r.winning).toBe(false);
        expect(r.accuracy).toBeLessThan(80);
    });

    test("reads the game from Black's side", () => {
        const g = game({ color: "black" });
        // Black's moves are e5, Nc6, Nd4: the last one throws away a won position.
        const r = reviewGame(g, ev([0, 0, 0, 0, 0, -400, 300]));
        expect(r.phases.opening.blunders).toBe(1);
        expect(r.errors[0].moveLabel).toBe("3…");
        expect(r.errors[0].before).toBe(400);
    });

    test("endgame and evaluation after move 15", () => {
        const moves = Array.from({ length: 40 }, (_, i) => (i % 2 ? "Nf6" : "Nf3")).join(" ");
        const evals = Array.from({ length: 41 }, (_, i) => (i >= 30 ? 150 : 0));
        const r = reviewGame(game({ moves }), ev(evals, { endgameFrom: 34 }));
        expect(r.eval15).toBe(150);
        expect(r.endgameEval).toBe(150);
        expect(r.phases.endgame.moves).toBe(3);
        expect(r.phases.middlegame.moves).toBe(2);
        expect(r.phases.opening.moves).toBe(15);
    });
});

describe("engineStats and insights", () => {
    test("conversion, comebacks and the insights about them", () => {
        const games: StatsGame[] = [];
        const evals: Record<string, GameEval> = {};
        const DAY = 864e5;
        const now = 100 * DAY;
        for (let i = 0; i < 12; i++) {
            // Clearly winning, but only 6 of 12 won.
            const g = game({ end: now - DAY, result: i < 6 ? "win" : i < 9 ? "draw" : "loss" });
            games.push(g);
            evals[g.id] = ev([20, 20, 300, 300, 300, 300, 300]);
        }
        const s = engineStats(games, evals, () => "Italian Game");
        expect(s.analysed).toBe(12);
        expect(s.conversion).toEqual({ n: 12, wins: 6, draws: 3, losses: 3 });
        expect(s.comebacks.n).toBe(0);
        const report = statsReport(
            games,
            { speed: "rapid", ratedOnly: true, days: 30 },
            now,
            evals,
        );
        const conv = report.insights.find((i) => i.key === "ConversionBad");
        expect(conv?.params).toMatchObject({ n: 12, share: 50, draws: 3, losses: 3 });
        expect(report.current.engine?.analysed).toBe(12);
        // Without analyses the engine part is absent.
        expect(
            statsReport(games, { speed: "rapid", ratedOnly: true, days: 30 }, now).current.engine,
        ).toBeNull();
    });
});
