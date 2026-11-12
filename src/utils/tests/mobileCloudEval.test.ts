import { beforeEach, describe, expect, test } from "vitest";
import { cloudEval, resetCloudCache } from "../../../mobile/src/cloudEval";

const FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

function fakeFetch(responses: { status: number; body?: unknown }[]) {
    const calls: { url: string; auth?: string }[] = [];
    const impl = (async (url: string, init?: RequestInit) => {
        calls.push({
            url,
            auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
        });
        const r = responses.shift() ?? { status: 500 };
        return new Response(r.body ? JSON.stringify(r.body) : null, { status: r.status });
    }) as unknown as typeof fetch;
    return { impl, calls };
}

beforeEach(() => resetCloudCache());

describe("cloudEval (phone)", () => {
    test("returns Lichess's lines and asks only once per position", async () => {
        const { impl, calls } = fakeFetch([
            {
                status: 200,
                body: {
                    fen: FEN,
                    depth: 46,
                    pvs: [
                        { moves: "c7c5 g1f3", cp: 30 },
                        { moves: "e7e5 g1f3", cp: 35 },
                    ],
                },
            },
        ]);
        const a = await cloudEval(FEN, "tok", impl);
        expect(a).toMatchObject({ depth: 46, source: "lichess", done: true });
        expect(a?.lines.map((l) => [l.multipv, l.pv[0], l.score.value])).toEqual([
            [1, "c7c5", 30],
            [2, "e7e5", 35],
        ]);
        expect(calls[0].url).toContain("multiPv=3");
        expect(calls[0].auth).toBe("Bearer tok");
        // Same position with other move counters: from memory.
        const again = await cloudEval(FEN.replace(" 0 1", " 4 7"), "tok", impl);
        expect(again?.depth).toBe(46);
        expect(calls).toHaveLength(1);
    });

    test("remembers missing positions, pauses after 429, retries when offline", async () => {
        const { impl, calls } = fakeFetch([{ status: 404 }, { status: 429 }]);
        expect(await cloudEval(FEN, "", impl)).toBeNull();
        expect(await cloudEval(FEN, "", impl)).toBeNull();
        expect(calls).toHaveLength(1);
        const other = "8/8/8/8/8/8/8/K6k w - - 0 1";
        expect(await cloudEval(other, "", impl)).toBeNull(); // 429
        expect(await cloudEval(other, "", impl)).toBeNull(); // paused: no request
        expect(calls).toHaveLength(2);

        resetCloudCache();
        const failing = (async () => {
            throw new Error("offline");
        }) as unknown as typeof fetch;
        expect(await cloudEval(FEN, "", failing)).toBeNull();
        const ok = fakeFetch([
            { status: 200, body: { fen: FEN, depth: 30, pvs: [{ moves: "c7c5", mate: 5 }] } },
        ]);
        expect((await cloudEval(FEN, "", ok.impl))?.lines[0].score).toEqual({
            type: "mate",
            value: 5,
        });
    });

    test("drops a token Lichess refuses", async () => {
        const { impl, calls } = fakeFetch([
            { status: 401 },
            { status: 200, body: { fen: FEN, depth: 40, pvs: [{ moves: "c7c5", cp: 20 }] } },
        ]);
        expect((await cloudEval(FEN, "bad", impl))?.depth).toBe(40);
        expect(calls.map((c) => c.auth)).toEqual(["Bearer bad", undefined]);
    });
});
