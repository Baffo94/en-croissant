import { describe, expect, test } from "vitest";
import { getPGN, innerParsePGN } from "../chess";
import { parsePgnGames } from "../pgnTree";
import {
    applyOp,
    continuations,
    countMoves,
    gameSpans,
    lexGame,
    readGame,
    type RepertoireOp,
} from "../repertoireEdit";

// As the desktop writes it.
const PHILIDOR = `[Event "Against Philidor"]
[Site "?"]
[Result "*"]
[Orientation "white"]

{Idee} 1. e4 e5 {[%eval +0.22] } 2. Nf3 d6 3. d4 exd4 4. Nxd4 Be7  (4... c5  5. Bb5+ Bd7) 5. Nc3 Nf6 6. Bf4 O-O 7. Be2 {[%eval +0.30] [%cal Ge2d2]Da cambiare. Meglio Dd2} Re8 *
`;

const SECOND = `[Event "Second"]
[Result "*"]

1. d4 d5 *
`;

const FILE = `${PHILIDOR}\n${SECOND}`;

const OPENING = ["e4", "e5", "Nf3", "d6", "d4", "exd4", "Nxd4", "Be7", "Nc3", "Nf6", "Bf4", "O-O"];

function movetext(text: string, game = 0) {
    const span = gameSpans(text)[game];
    return text.slice(span.movetextStart, span.end);
}

/** Applies an edit, then its inverse: back to the same file. */
function roundTrip(text: string, op: RepertoireOp) {
    const done = applyOp(text, 0, op);
    expect(done.changed).toBe(true);
    expect(done.inverse).not.toBeNull();
    const undone = applyOp(done.text, 0, done.inverse!);
    expect(undone.text).toBe(text);
    return done;
}

describe("reading and writing", () => {
    test("a file written by the desktop is written back the same", () => {
        const read = readGame(FILE, 0)!;
        expect(read.root.comment).toBe("Idee");
        // No change: same text, same object.
        expect(applyOp(FILE, 0, { kind: "add", line: ["e4"] }).text).toBe(FILE);
        expect(gameSpans(FILE).length).toBe(parsePgnGames(FILE).length);
    });

    test("glyphs are numeric NAGs, as for pgn-reader", () => {
        expect(lexGame("1. e4!? e5 ?! *")).toEqual([
            { type: "San", value: "e4" },
            { type: "Nag", value: "$5" },
            { type: "San", value: "e5" },
            { type: "Nag", value: "$6" },
            { type: "Outcome", value: "*" },
        ]);
    });
});

describe("edits", () => {
    test("add: a new continuation, a new variation, idempotent", () => {
        const done = roundTrip(FILE, { kind: "add", line: [...OPENING, "Be2", "Re8", "Qd2"] });
        expect(movetext(done.text)).toMatch(/Re8 8\. Qd2 \*$/);
        const variation = roundTrip(FILE, { kind: "add", line: [...OPENING, "Qd2"] });
        expect(movetext(variation.text)).toContain("(7. Qd2  )");
        // Again: nothing to add.
        expect(applyOp(variation.text, 0, { kind: "add", line: [...OPENING, "Qd2"] }).changed).toBe(
            false,
        );
        // The other game of the file is untouched.
        expect(variation.text.endsWith(SECOND)).toBe(true);
    });

    test("add: illegal or unknown positions change nothing", () => {
        expect(applyOp(FILE, 0, { kind: "add", line: ["e4", "Ke2"] }).changed).toBe(false);
        expect(applyOp(FILE, 0, { kind: "add", line: ["d4", "d5"] }).changed).toBe(false);
    });

    test("promote: the variation becomes the main move, the old one a variation", () => {
        const added = applyOp(FILE, 0, { kind: "add", line: [...OPENING, "Qd2"] }).text;
        const done = roundTrip(added, { kind: "promote", line: [...OPENING, "Qd2"] });
        const root = readGame(done.text, 0)!.root;
        expect(continuations(root, OPENING)).toEqual(["Qd2", "Be2"]);
        // The comment and arrow of 7.Be2 travel with it.
        expect(movetext(done.text)).toContain(
            "(7. Be2 {[%eval +0.30] [%cal Ge2d2]Da cambiare. Meglio Dd2}",
        );
    });

    test("delete: the move and what follows; undo puts it back where it was", () => {
        const done = roundTrip(FILE, { kind: "delete", line: [...OPENING.slice(0, 7), "Be7"] });
        const root = readGame(done.text, 0)!.root;
        expect(continuations(root, OPENING.slice(0, 7))).toEqual(["c5"]);
        expect(done.inverse).toMatchObject({ kind: "restore", index: 0 });
        if (done.inverse?.kind === "restore") expect(countMoves(done.inverse.node)).toBe(7);
    });

    test("comments and symbols", () => {
        const done = roundTrip(FILE, {
            kind: "comment",
            line: [...OPENING, "Be2"],
            text: "Meglio Dd2",
        });
        expect(movetext(done.text)).toContain("7. Be2 {[%eval +0.30] [%cal Ge2d2]Meglio Dd2}");
        const root = roundTrip(FILE, { kind: "comment", line: [], text: "Nuove idee" });
        expect(movetext(root.text).startsWith("{Nuove idee} 1. e4")).toBe(true);
        const nags = roundTrip(FILE, { kind: "nags", line: [...OPENING, "Be2"], nags: ["?!"] });
        expect(movetext(nags.text)).toContain("7. Be2 $6 {");
        expect(
            applyOp(nags.text, 0, { kind: "nags", line: [...OPENING, "Be2"], nags: ["?!"] })
                .changed,
        ).toBe(false);
    });

    test("the second game of a file and a game from another position", () => {
        const done = applyOp(FILE, 1, { kind: "add", line: ["d4", "d5", "c4"] });
        expect(done.text.startsWith(PHILIDOR)).toBe(true);
        expect(movetext(done.text, 1)).toBe("1. d4 d5 2. c4 *");
        const fen = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1";
        const setup = `[Event "x"]\n[SetUp "1"]\n[FEN "${fen}"]\n\n*\n`;
        const added = applyOp(setup, 0, { kind: "add", line: ["e4"] });
        expect(added.text).toBe(`[Event "x"]\n[SetUp "1"]\n[FEN "${fen}"]\n\n1. e4 *\n`);
    });

    test("the movetext is what the desktop writer gives for the edited tree", () => {
        const done = applyOp(FILE, 0, { kind: "add", line: [...OPENING, "Qd2"] });
        const root = innerParsePGN(lexGame(movetext(done.text)), undefined).root;
        const desktop = getPGN(root, {
            headers: null,
            comments: true,
            extraMarkups: true,
            glyphs: true,
            variations: true,
        });
        expect(movetext(done.text)).toBe(`${desktop} *`);
    });
});
