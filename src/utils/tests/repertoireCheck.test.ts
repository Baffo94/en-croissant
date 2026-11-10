import { describe, expect, test } from "vitest";
import {
    type CheckSettings,
    checkRepertoires,
    DEFAULT_CHECK_SETTINGS,
    type EngineLine,
    type ExplorerData,
    fenKey,
} from "@/utils/repertoireCheck";
import { parsePgnGames } from "@/utils/pgnTree";
import type { TreeNode } from "@/utils/treeReducer";

const noEngine: CheckSettings = { ...DEFAULT_CHECK_SETTINGS, engineMs: 0 };
const emptyExplorer = async (): Promise<ExplorerData> => ({
    white: 0,
    black: 0,
    draws: 0,
    moves: [],
});
const noAnalysis = async (): Promise<EngineLine[]> => [];

/** FEN reached by a line of a PGN. */
function fenAfter(pgn: string, sans: string[]): string {
    let node: TreeNode = parsePgnGames(pgn)[0].root;
    for (const san of sans) node = node.children.find((c) => c.san === san)!;
    return node.fen;
}

describe("inconsistencies", () => {
    test("the same position answered differently in two sections of a group", async () => {
        const a = {
            path: "A",
            label: "Italiana",
            group: "Aperte",
            text: `[Orientation "white"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 *`,
        };
        const b = {
            path: "B",
            label: "Spagnola",
            group: "Aperte",
            text: `[Orientation "white"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 *`,
        };
        const c = {
            path: "C",
            label: "Nero",
            text: `[Orientation "black"]\n\n1. e4 e5 2. Nf3 Nf6 *`,
        };
        // Another repertoire (other group) may answer differently on purpose.
        const d = {
            path: "D",
            label: "Scozzese",
            text: `[Orientation "white"]\n\n1. e4 e5 2. Nf3 Nc6 3. d4 *`,
        };
        const r = await checkRepertoires([a, b, c, d], ["A", "B", "C", "D"], noEngine, {
            explore: emptyExplorer,
            analyse: noAnalysis,
        });
        expect(
            r.A.map((i) => [
                i.kind,
                i.line.join(" "),
                i.kind === "inconsistent" && i.others[0].move,
            ]),
        ).toEqual([["inconsistent", "e4 e5 Nf3 Nc6", "Bb5"]]);
        expect(r.B.map((i) => i.kind === "inconsistent" && i.others[0].label)).toEqual([
            "Italiana",
        ]);
        // Black repertoire: its own positions only, nothing to compare with.
        expect(r.C).toEqual([]);
        expect(r.D).toEqual([]);
    });

    test("a transposition inside one file (the Caro-Kann case)", async () => {
        const fixed = `[Orientation "black"]\n\n1. e4 c6 2. d4 (2. Nf3 d5 3. d4 Bg4) 2... d5 3. Nf3 dxe4 *`;
        const r = await checkRepertoires(
            [{ path: "K", label: "Caro", text: fixed }],
            ["K"],
            noEngine,
            {
                explore: emptyExplorer,
                analyse: noAnalysis,
            },
        );
        // One issue per position, naming the other answer.
        expect(r.K.map((i) => i.kind === "inconsistent" && [i.move, i.others[0].move])).toEqual([
            ["dxe4", "Bg4"],
        ]);
    });
});

describe("holes", () => {
    const pgn = `[Orientation "white"]\n\n1. e4 e5 (1... c5 2. Nf3 d6 3. d4) 2. Nf3 Nc6 3. Bc4 *`;
    const file = { path: "W", label: "Bianco", text: pgn };
    const other = {
        path: "O",
        label: "Altro",
        text: `[Orientation "white"]\n\n1. e4 c6 2. d4 d5 *`,
    };
    const start = fenKey(fenAfter(pgn, ["e4"]));
    const afterNf3 = fenKey(fenAfter(pgn, ["e4", "e5", "Nf3"]));
    const explorer = async (fen: string): Promise<ExplorerData> => {
        if (fenKey(fen) === start)
            return {
                white: 400,
                black: 400,
                draws: 200,
                moves: [
                    { uci: "e7e5", san: "e5", white: 300, black: 300, draws: 100 },
                    { uci: "c7c5", san: "c5", white: 100, black: 100, draws: 50 },
                    { uci: "e7e6", san: "e6", white: 0, black: 0, draws: 30 }, // 3%: below
                    { uci: "c7c6", san: "c6", white: 50, black: 40, draws: 20 }, // 11%: in "Altro"
                ],
            };
        if (fenKey(fen) === afterNf3)
            return {
                white: 30,
                black: 10,
                draws: 0,
                moves: [{ uci: "d7d6", san: "d6", white: 20, black: 10, draws: 0 }], // only 40 games
            };
        return {
            white: 500,
            black: 300,
            draws: 200,
            moves: [{ uci: "a7a6", san: "a6", white: 100, black: 50, draws: 50 }],
        };
    };

    test("frequent unprepared moves; not prepared moves reached by transposition; small samples", async () => {
        const r = await checkRepertoires([file, other], ["W"], noEngine, {
            explore: explorer,
            analyse: noAnalysis,
        });
        // After 1...c5 2.Nf3 (Black to move): 2...a6 is played in 20% → hole.
        // The end of a line (after 3.Bc4, 3.d4) is never judged.
        expect(
            r.W.map(
                (i) => i.kind === "hole" && [i.line.join(" "), i.move, Math.round(i.share * 100)],
            ),
        ).toEqual([["e4 c5 Nf3", "a6", 20]]);
    });
});

describe("engine", () => {
    const white = `[Orientation "white"]\n\n1. e4 e5 2. Qh5 *`;
    const black = `[Orientation "black"]\n\n1. e4 f6 *`;

    test("a move losing more than the threshold is dubious, from either side", async () => {
        const lines = async (fen: string): Promise<EngineLine[]> => {
            if (fenKey(fen) === fenKey(fenAfter(white, ["e4", "e5"])))
                return [
                    { uci: "g1f3", san: "Nf3", score: 40 },
                    { uci: "b1c3", san: "Nc3", score: 30 },
                ];
            if (fenKey(fen) === fenKey(fenAfter(white, ["e4", "e5", "Qh5"])))
                return [{ uci: "b8c6", san: "Nc6", score: -40 }];
            if (fenKey(fen) === fenKey(fenAfter(black, ["e4"])))
                return [
                    { uci: "e7e5", san: "e5", score: 30 },
                    { uci: "c7c5", san: "c5", score: 35 },
                ];
            if (fenKey(fen) === fenKey(fenAfter(black, ["e4", "f6"])))
                return [{ uci: "d2d4", san: "d4", score: 150 }];
            return [{ uci: "e2e4", san: "e4", score: 30 }];
        };
        const r = await checkRepertoires(
            [
                { path: "W", label: "W", text: white },
                { path: "B", label: "B", text: black },
            ],
            ["W", "B"],
            DEFAULT_CHECK_SETTINGS,
            { explore: emptyExplorer, analyse: lines },
        );
        const dubious = (k: string) =>
            r[k]
                .filter((i) => i.kind === "dubious")
                .map((i) => i.kind === "dubious" && [i.move, i.best, i.loss]);
        expect(dubious("W")).toEqual([["Qh5", "Nf3", 80]]);
        expect(dubious("B")).toEqual([["f6", "e5", 120]]);
    });

    test("a move among the engine lines is judged from them; small losses are fine", async () => {
        const analysed: string[] = [];
        const r = await checkRepertoires(
            [{ path: "W", label: "W", text: white }],
            ["W"],
            DEFAULT_CHECK_SETTINGS,
            {
                explore: emptyExplorer,
                analyse: async (fen) => {
                    analysed.push(fen);
                    return [
                        { uci: "x", san: "Nf3", score: 40 },
                        { uci: "y", san: "Qh5", score: -20 },
                        { uci: "z", san: "e4", score: 30 },
                    ];
                },
            },
        );
        expect(r.W.filter((i) => i.kind === "dubious").map((i) => i.move)).toEqual([]);
        // Two positions of White (start, after 1...e5), no extra analysis after the move.
        expect(analysed.length).toBe(2);
    });
});

describe("move text", () => {
    const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    test("lines and next moves with their numbers", async () => {
        const { formatLine, formatNextMove } = await import("@/utils/repertoireCheck");
        expect(formatLine(START, ["e4", "e5", "Nf3"])).toBe("1. e4 e5 2. Nf3");
        expect(formatNextMove(START, ["e4", "e5", "Nf3"], "Nc6")).toBe("2... Nc6");
        expect(formatNextMove(START, ["e4", "e5"], "Nf3")).toBe("2. Nf3");
        expect(formatNextMove(START, [], "e4")).toBe("1. e4");
    });
});
