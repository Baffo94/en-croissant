import { parsePgn, type ChildNode, type PgnNodeData } from "chessops/pgn";
import { describe, expect, test } from "vitest";
import type { Token } from "@/bindings";
import { buildFromTree } from "@/components/files/opening";
import { innerParsePGN } from "../chess";
import { parsePgnGames } from "../pgnTree";
import type { TreeNode } from "../treeReducer";

// Emits the token stream the Rust lexer (pgn-reader) produces for a game:
// mainline move, then its alternatives as ( ... ), then the continuation.
function tokensOf(children: ChildNode<PgnNodeData>[], out: Token[] = []): Token[] {
    if (children.length === 0) return out;
    const [main, ...alts] = children;
    out.push({ type: "San", value: main.data.san });
    for (const alt of alts) {
        out.push({ type: "ParenOpen" } as Token);
        out.push({ type: "San", value: alt.data.san });
        tokensOf(alt.children, out);
        out.push({ type: "ParenClose" } as Token);
    }
    return tokensOf(main.children, out);
}

function shape(node: TreeNode): unknown {
    return {
        fen: node.fen,
        san: node.san,
        halfMoves: node.halfMoves,
        children: node.children.map(shape),
    };
}

const PGNS = [
    `[Event "White rep"]
[Orientation "white"]

1. e4 e5 (1... c5 2. Nf3 d6 (2... Nc6 3. d4) (2... e6 3. d4) 3. d4) (1... e6 2. d4 d5) 2. Nf3 Nc6 (2... Nf6 3. Nxe5) 3. Bb5 a6 4. Ba4 *`,
    `[Event "Black rep"]
[Orientation "black"]
[Start "[0]"]

1. e4 {comment} c5 $1 2. Nf3 (2. c3 d5 3. exd5 Qxd5) (2. Nc3 Nc6) 2... d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 *`,
    `[Event "From FEN"]
[FEN "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2"]
[SetUp "1"]
[Orientation "white"]

2. Nf3 d6 (2... Nc6 3. Bb5) 3. d4 cxd4 4. Nxd4 *`,
    `[Event "Transpositions"]
[Orientation "white"]

1. d4 Nf6 (1... d5 2. c4 e6 3. Nc3 Nf6) 2. c4 e6 3. Nc3 d5 (3... Bb4 4. Qc2) *`,
];

describe("parsePgnGames matches the desktop parser", () => {
    for (const pgn of PGNS) {
        test(pgn.split("\n")[0], () => {
            const [game] = parsePgnGames(pgn);
            const reference = parsePgn(pgn)[0];
            const fen = (reference.headers.get("FEN") ?? "").trim() || undefined;
            const desktop = innerParsePGN(
                tokensOf(reference.moves.children),
                fen ?? "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            );
            expect(shape(game.root)).toEqual(shape(desktop.root));
            for (const color of ["white", "black"] as const) {
                const strip = (cards: ReturnType<typeof buildFromTree>) =>
                    cards.map((c) => [c.fen, c.answer]);
                expect(strip(buildFromTree(game.root, color, game.start))).toEqual(
                    strip(buildFromTree(desktop.root, color, game.start)),
                );
            }
        });
    }

    test("headers", () => {
        const games = parsePgnGames(`${PGNS[1]}\n\n${PGNS[0]}`);
        expect(games).toHaveLength(2);
        expect(games[0].orientation).toBe("black");
        expect(games[0].start).toEqual([0]);
        expect(games[1].orientation).toBe("white");
        expect(buildFromTree(games[0].root, "black", games[0].start).length).toBeGreaterThan(3);
    });
});
