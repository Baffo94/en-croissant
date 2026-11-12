import { describe, expect, test } from "vitest";
import type { BestMoves } from "@/bindings";
import {
    fenAfter,
    fromBestMoves,
    isOpeningFen,
    sourceLabel,
    storedSource,
    toBestMoves,
} from "@/utils/evalCache";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("evaluation database helpers", () => {
    test("position after UCI moves; illegal moves give null", () => {
        expect(fenAfter(START, ["e2e4", "e7e5"])).toBe(
            "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
        );
        expect(fenAfter(START, ["e2e5"])).toBeNull();
    });

    test("opening = up to move 20", () => {
        expect(isOpeningFen(START)).toBe(true);
        expect(isOpeningFen("8/8/8/8/8/8/8/K6k w - - 0 21")).toBe(false);
    });

    test("engine lines and stored lines convert both ways", () => {
        const lines: BestMoves[] = [
            {
                nodes: 1,
                depth: 24,
                score: { value: { type: "cp", value: 31 }, wdl: null },
                uciMoves: ["e2e4"],
                sanMoves: ["e4"],
                multipv: 1,
                nps: 1,
            },
            {
                nodes: 1,
                depth: 23,
                score: { value: { type: "mate", value: -4 }, wdl: null },
                uciMoves: ["d2d4"],
                sanMoves: ["d4"],
                multipv: 2,
                nps: 1,
            },
        ];
        const stored = fromBestMoves(lines, "stockfish");
        expect(stored.depth).toBe(23);
        const back = toBestMoves(stored);
        expect(back.map((l) => [l.score.value, l.sanMoves, l.multipv])).toEqual([
            [{ type: "cp", value: 31 }, ["e4"], 1],
            [{ type: "mate", value: -4 }, ["d4"], 2],
        ]);
    });
});

describe("storedSource", () => {
    test("remembers where the lines on screen came from", () => {
        const lines = toBestMoves({
            depth: 45,
            source: "lichess",
            lichessChecked: true,
            lines: [
                { uciMoves: ["e2e4"], sanMoves: ["e4"], cp: 20, mate: null, depth: 45, multipv: 1 },
            ],
        });
        expect(storedSource(lines)).toEqual({ source: "lichess", depth: 45 });
        expect(storedSource([...lines])).toBeUndefined();
        expect(storedSource(undefined)).toBeUndefined();
        expect(sourceLabel("lichess")).toBe("Lichess");
        expect(sourceLabel("Stockfish 17")).toBe("Stockfish 17");
    });
});
