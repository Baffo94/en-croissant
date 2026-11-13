import { describe, expect, test } from "vitest";
import type { StatsGame } from "@/utils/accountStats";
import { buildMoments, judgeCandidate, summarizeAttempts } from "../candidates";

const MOVES =
    "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4 exd4 cxd4 Bb4+ Bd2 Bxd2+ Nbxd2 d5 exd5 Nxd5 Qb3 Nce7 O-O c6";

function game(over: Partial<StatsGame>): StatsGame {
    return {
        id: "g1",
        source: "chesscom",
        url: "https://chess.com/game/1",
        start: 0,
        end: 1000,
        speed: "rapid",
        timeControl: "600",
        rated: true,
        color: "white",
        rating: 1500,
        oppRating: 1500,
        opponent: "rival",
        result: "win",
        ending: "resign",
        moves: MOVES,
        clocks: [],
        opening: null,
        ...over,
    };
}

describe("buildMoments", () => {
    test("punished errors and turning points after the opening", () => {
        const evals: (number | null)[] = Array(23).fill(30);
        evals[16] = 300; // 8...d5? gives White a lot
        evals[17] = 290; // 9.exd5 keeps it: punished
        evals[18] = 200;
        evals[19] = 60; // 10.Qb3 lets it slip: a turning point
        evals[20] = 60;
        evals[21] = 50;
        const best = MOVES.split(" ").concat("");
        best[18] = "O-O";
        const moments = buildMoments([game({})], {
            g1: { evals, best, endgameFrom: null },
        });
        expect(moments.map((m) => [m.id, m.kind, m.played, m.best, m.moveLabel])).toEqual([
            ["g1#16", "punished", "exd5", "exd5", "9."],
            ["g1#18", "turning", "Qb3", "O-O", "10."],
        ]);
        expect(moments[1].evalBefore).toBe(200);
    });

    test("the same moves from Black's side, and nothing in the opening", () => {
        const evals: (number | null)[] = Array(23).fill(-30);
        evals[3] = 300; // a gift for Black, but still in the opening
        evals[4] = 300;
        evals[17] = -300; // 9.exd5? would be a gift for Black…
        evals[18] = -40; // …that 9...Nxd5 lets go
        const moments = buildMoments([game({ color: "black" })], {
            g1: { evals, best: MOVES.split(" ").concat(""), endgameFrom: null },
        });
        expect(moments.map((m) => [m.id, m.kind])).toEqual([["g1#17", "missed"]]);
    });
});

describe("judging candidates", () => {
    test("verdicts by lost winning chances", () => {
        expect(judgeCandidate(100, 100, true)).toBe("best");
        expect(judgeCandidate(100, 80, false)).toBe("good");
        expect(judgeCandidate(100, 0, false)).toBe("inaccuracy");
        expect(judgeCandidate(100, -60, false)).toBe("mistake");
        expect(judgeCandidate(100, -600, false)).toBe("blunder");
    });

    test("summary", () => {
        expect(summarizeAttempts([])).toEqual({ done: 0, foundBest: null, goodChoice: null });
        const s = summarizeAttempts([
            { id: "a", at: "", candidates: ["e2e4"], foundBest: true, choice: "best" },
            { id: "b", at: "", candidates: ["e2e4"], foundBest: true, choice: "mistake" },
            { id: "c", at: "", candidates: ["e2e4"], foundBest: false, choice: "good" },
            { id: "d", at: "", candidates: ["e2e4"], foundBest: false, choice: "blunder" },
        ]);
        expect(s).toEqual({ done: 4, foundBest: 0.5, goodChoice: 0.5 });
    });
});
