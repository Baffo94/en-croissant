// Pure-TypeScript PGN -> move tree, used where the Rust PGN lexer is not available
// (the mobile app). It must produce the same FENs, SANs and halfMoves as
// `innerParsePGN` in ./chess.ts, because practice cards are keyed by FEN.

import { parseUci } from "chessops";
import { INITIAL_FEN, makeFen, parseFen } from "chessops/fen";
import { type ChildNode, type PgnNodeData, parsePgn } from "chessops/pgn";
import { makeSan, parseSan } from "chessops/san";
import { positionFromFen } from "./chessops";
import { createNode, type TreeNode } from "./treeReducer";

export type PgnGame = {
    headers: Map<string, string>;
    orientation: "white" | "black";
    /** Path (child indices) of the first position to practice, from the "Start" header. */
    start: number[];
    root: TreeNode;
};

function rootNode(fen: string): TreeNode {
    const setup = parseFen(fen).unwrap();
    return {
        fen,
        move: null,
        san: null,
        children: [],
        score: null,
        depth: null,
        halfMoves: (setup.fullmoves - 1) * 2 + (setup.turn === "black" ? 1 : 0),
        shapes: [],
        annotations: [],
        comment: "",
    };
}

function addChildren(parent: TreeNode, children: ChildNode<PgnNodeData>[]) {
    for (const child of children) {
        const [pos, error] = positionFromFen(parent.fen);
        if (error) continue;
        const token = child.data.san;
        const move = parseSan(pos, token) ?? parseUci(token);
        if (!move) {
            // Like the desktop parser: skip the bad move and keep reading from here.
            addChildren(parent, child.children);
            continue;
        }
        const san = makeSan(pos, move);
        pos.play(move);
        const node = createNode({
            fen: makeFen(pos.toSetup()),
            move,
            san,
            halfMoves: parent.halfMoves + 1,
        });
        parent.children.push(node);
        addChildren(node, child.children);
    }
}

function parseStart(value: string | undefined): number[] {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) && parsed.every((n) => typeof n === "number") ? parsed : [];
    } catch {
        return [];
    }
}

/** Parses every game of a PGN file, in file order (= desktop game numbers). */
export function parsePgnGames(text: string): PgnGame[] {
    return parsePgn(text).map((game) => {
        const fen = (game.headers.get("FEN") ?? INITIAL_FEN).trim();
        const root = rootNode(fen);
        addChildren(root, game.moves.children);
        const orientation = game.headers.get("Orientation");
        return {
            headers: game.headers,
            orientation: orientation === "black" ? "black" : "white",
            start: parseStart(game.headers.get("Start")),
            root,
        };
    });
}
