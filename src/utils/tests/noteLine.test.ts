import { describe, expect, test } from "vitest";
import { formatLine, notePgn } from "@/utils/noteLine";
import { parsePgnGames } from "@/utils/pgnTree";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("note lines", () => {
    test("move numbers from the start and from a position with black to move", () => {
        expect(formatLine(START, ["e4", "e5", "Nf3"])).toBe("1. e4 e5 2. Nf3");
        expect(formatLine("8/8/8/8/8/8/8/K6k b - - 0 30", ["Kg1", "Kb1"])).toBe(
            "30... Kg1 31. Kb1",
        );
    });

    test("the PGN of a note replays to the same moves with the note as comment", () => {
        const pgn = notePgn({
            startFen: START,
            line: ["e4", "e5", "Bc4"],
            text: "Perché {non} d4?",
        });
        const game = parsePgnGames(pgn)[0];
        let node = game.root;
        const sans: string[] = [];
        while (node.children[0]) {
            node = node.children[0];
            sans.push(node.san ?? "");
        }
        expect(sans).toEqual(["e4", "e5", "Bc4"]);
        expect(node.comment).toBe("Perché non d4?");
    });
});
