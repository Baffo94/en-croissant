import { describe, expect, test } from "vitest";
import type { BestMoves } from "@/bindings";
import {
    deepEnough,
    depthProgress,
    evaluationSignature,
    keepDeeper,
    linesDepth,
} from "../engineFloor";

function lines(depth: number, count: number, cp = 20): BestMoves[] {
    return Array.from({ length: count }, (_, i) => ({
        nodes: 1000,
        depth,
        score: { value: { type: "cp", value: cp - i * 10 }, wdl: null },
        uciMoves: [`e2e${i + 3}`],
        sanMoves: [`e${i + 3}`],
        multipv: i + 1,
        nps: 1,
    }));
}

describe("keeping the deeper lines", () => {
    test("nothing shown yet: the new lines", () => {
        expect(keepDeeper(undefined, lines(1, 2))).toEqual(lines(1, 2));
        expect(keepDeeper([], lines(1, 2))).toEqual(lines(1, 2));
    });

    test("a restarted search does not replace deeper lines until it catches up", () => {
        const deep = lines(30, 2);
        expect(keepDeeper(deep, lines(1, 2))).toBeNull();
        expect(keepDeeper(deep, lines(29, 2))).toBeNull();
        expect(keepDeeper(deep, lines(30, 2, 35))).toEqual(lines(30, 2, 35));
        expect(keepDeeper(deep, lines(31, 2))).toEqual(lines(31, 2));
    });

    test("more lines asked for: shown at once; fewer: the deeper ones, cut", () => {
        const deep = lines(30, 2);
        expect(keepDeeper(deep, lines(3, 3))).toEqual(lines(3, 3));
        expect(keepDeeper(deep, lines(3, 1))).toEqual(lines(30, 1));
    });

    test("an empty answer changes nothing", () => {
        expect(keepDeeper(lines(10, 1), [])).toBeNull();
    });
});

describe("depth limit", () => {
    test("progress of the lines on screen", () => {
        expect(depthProgress(lines(15, 1), { t: "Depth", c: 30 })).toBe(50);
        expect(depthProgress(lines(40, 1), { t: "Depth", c: 30 })).toBe(100);
        expect(depthProgress(lines(15, 1), { t: "Infinite" })).toBe(0);
        expect(linesDepth(undefined)).toBe(0);
    });

    test("already deep enough: no new search", () => {
        expect(deepEnough(lines(30, 2), { t: "Depth", c: 25 }, 2)).toBe(true);
        expect(deepEnough(lines(30, 2), { t: "Depth", c: 31 }, 2)).toBe(false);
        expect(deepEnough(lines(30, 2), { t: "Depth", c: 25 }, 3)).toBe(false);
        expect(deepEnough(lines(30, 2), { t: "Infinite" }, 1)).toBe(false);
        expect(deepEnough(undefined, { t: "Depth", c: 1 }, 1)).toBe(false);
    });
});

test("only options that change the evaluation count", () => {
    const base = [
        { name: "Threads", value: 4 },
        { name: "Hash", value: 256 },
        { name: "MultiPV", value: 2 },
        { name: "Contempt", value: 0 },
    ];
    const sig = evaluationSignature(base);
    expect(
        evaluationSignature(base.map((o) => (o.name === "MultiPV" ? { ...o, value: 3 } : o))),
    ).toBe(sig);
    expect(
        evaluationSignature(base.map((o) => (o.name === "Threads" ? { ...o, value: 8 } : o))),
    ).toBe(sig);
    expect(
        evaluationSignature(base.map((o) => (o.name === "Contempt" ? { ...o, value: 10 } : o))),
    ).not.toBe(sig);
});
