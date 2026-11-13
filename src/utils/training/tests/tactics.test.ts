import { describe, expect, test } from "vitest";
import type { StatsGame } from "@/utils/accountStats";
import type { GameEval } from "@/utils/gameReview";
import { buildTactics, isGoodAnswer } from "../tactics";

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
        result: "loss",
        ending: "resign",
        moves: "e4 e5 Nf3 Nc6 Bc4 Nd4 Nxe5",
        clocks: [],
        opening: null,
        ...over,
    };
}

const ev = (evals: (number | null)[], best: string[]): GameEval => ({
    evals,
    best,
    endgameFrom: null,
});

describe("buildTactics", () => {
    test("your mistakes become exercises with the engine's move", () => {
        // 4.Nxe5? (index 6) drops from +60 to -300; the engine wanted 4.c3.
        const g = game({});
        const tactics = buildTactics([g], {
            g1: ev(
                [20, 30, 25, 30, 30, 60, 60, -300],
                ["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6", "c3", ""],
            ),
        });
        expect(tactics).toHaveLength(1);
        expect(tactics[0]).toMatchObject({
            id: "g1#6",
            color: "white",
            best: "c3",
            bestUci: "c2c3",
            played: "Nxe5",
            evalBest: 60,
            evalPlayed: -300,
            kind: "error",
            moveLabel: "4.",
            opponent: "rival",
        });
        expect(tactics[0].fen).toBe(
            "r1bqkbnr/pppp1ppp/8/4p3/2BnP3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
        );
    });

    test("a missed punishment is marked as such, from Black's side too", () => {
        // Black: 3...Nd4 is fine; White's 4.Nxe5?? (+20 -> -300 for White) then Black plays
        // 4...Nxe5?? missing 4...Qg5.
        const g = game({ color: "black", moves: "e4 e5 Nf3 Nc6 Bc4 Nd4 Nxe5 Nxe5" });
        const tactics = buildTactics([g], {
            g1: ev(
                [20, 30, 25, 30, 30, 20, 20, -300, 100],
                ["e4", "e5", "Nf3", "Nc6", "Bc4", "Nd4", "c3", "Qg5", ""],
            ),
        });
        expect(tactics.map((t) => [t.id, t.kind, t.best, t.played, t.moveLabel])).toEqual([
            ["g1#7", "missed", "Qg5", "Nxe5", "4..."],
        ]);
        expect(tactics[0].evalBest).toBe(300);
    });

    test("answers within an inaccuracy of the engine's move are right", () => {
        expect(isGoodAnswer(300, 280)).toBe(true);
        expect(isGoodAnswer(100, -50)).toBe(false);
    });
});
