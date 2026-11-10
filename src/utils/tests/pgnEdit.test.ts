import { describe, expect, test } from "vitest";
import { getMoveComment, setMoveComment } from "@/utils/pgnEdit";
import { parsePgnGames } from "@/utils/pgnTree";
import type { TreeNode } from "@/utils/treeReducer";

/** Every node as "path => comment | annotations", to compare whole trees. */
function snapshot(pgn: string, game = 0): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (node: TreeNode, path: string[]) => {
        out.set(path.join(" "), `${node.comment} | ${node.annotations.join(",")} | ${node.fen}`);
        for (const child of node.children) walk(child, [...path, child.san ?? ""]);
    };
    walk(parsePgnGames(pgn)[game].root, []);
    return out;
}

function expectOnlyChanged(
    before: string,
    after: string,
    line: string[],
    comment: string,
    game = 0,
) {
    const a = snapshot(before, game);
    const b = snapshot(after, game);
    expect([...b.keys()]).toEqual([...a.keys()]);
    for (const [path, value] of a) {
        if (path === line.join(" ")) expect(b.get(path)!.split(" | ")[0]).toBe(comment);
        else expect(b.get(path), path).toBe(value);
    }
}

const PGN = `[Event "Scotch"]
[Orientation "white"]
[Start "[0,0,0,0,0]"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 {[%csl Gd4][%cal Gd1d4]Centro} Nf6 (4... Bc5 5. Nb3 {Potter} (5. Be3 Qf6) 5... Bb6 $6) (4... Nxd4 5. Qxd4 $1 {[%eval 0.35,20] }) 5. Nxc6 bxc6 6. e5 *

[Event "Second"]

1. d4 d5 2. c4 *
`;

describe("editing a move comment in the PGN text", () => {
    test("replaces the text and keeps arrows and highlights", () => {
        const line = ["e4", "e5", "Nf3", "Nc6", "d4", "exd4", "Nxd4"];
        const after = setMoveComment(PGN, 0, line, "Il centro è mio")!;
        expect(after).toContain("{[%csl Gd4][%cal Gd1d4] Il centro è mio}");
        expectOnlyChanged(PGN, after, line, "Il centro è mio");
        // The rest of the file is byte-identical.
        expect(after.replace("[%cal Gd1d4] Il centro è mio", "[%cal Gd1d4]Centro")).toBe(PGN);
    });

    test("adds a comment to a move inside nested variations", () => {
        const line = ["e4", "e5", "Nf3", "Nc6", "d4", "exd4", "Nxd4", "Bc5", "Be3"];
        const after = setMoveComment(PGN, 0, line, "Più solida")!;
        expect(after).toContain("(5. Be3 {Più solida} Qf6)");
        expectOnlyChanged(PGN, after, line, "Più solida");
    });

    test("comment after a NAG, keeping the evaluation directive", () => {
        const line = ["e4", "e5", "Nf3", "Nc6", "d4", "exd4", "Nxd4", "Nxd4", "Qxd4"];
        expect(getMoveComment(PGN, 0, line)).toBe("");
        const after = setMoveComment(PGN, 0, line, "Donna al centro")!;
        expect(after).toContain("5. Qxd4 $1 {[%eval 0.35,20] Donna al centro}");
        expectOnlyChanged(PGN, after, line, "Donna al centro");
    });

    test("removing a comment without directives removes the braces", () => {
        const line = ["e4", "e5", "Nf3", "Nc6", "d4", "exd4", "Nxd4", "Bc5", "Nb3"];
        expect(getMoveComment(PGN, 0, line)).toBe("Potter");
        const after = setMoveComment(PGN, 0, line, "")!;
        expect(after).toContain("5. Nb3 (5. Be3");
        expectOnlyChanged(PGN, after, line, "");
    });

    test("second game of the file", () => {
        const after = setMoveComment(PGN, 1, ["d4", "d5", "c4"], "Gambetto")!;
        expect(after).toContain("2. c4 {Gambetto} *");
        expectOnlyChanged(PGN, after, ["d4", "d5", "c4"], "Gambetto", 1);
        expect(snapshot(after, 0)).toEqual(snapshot(PGN, 0));
    });

    test("braces typed in the text cannot break the PGN; unknown moves are refused", () => {
        const line = ["e4"];
        const after = setMoveComment(PGN, 0, line, "a {b} c")!;
        expect(getMoveComment(after, 0, line)).toBe("a b c");
        expect(setMoveComment(PGN, 0, ["e4", "c5"], "x")).toBeNull();
    });
});
