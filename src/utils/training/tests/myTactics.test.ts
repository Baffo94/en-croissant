import { expect, test } from "vitest";
import { readGame } from "@/utils/repertoireEdit";
import {
    answer,
    appendTactic,
    giveUp,
    newAttempt,
    normalizeTags,
    parseCollection,
    selectTactics,
    solutionParts,
    tacticPgn,
    tagsOf,
} from "../myTactics";

// Black to move after 1.f3 e5 2.g4 (a variation, a comment, a glyph).
const FEN = "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2";
const MOVES = "2... d5 $1 {Apre la diagonale} 3. h3 (3. Bg2 Qh4+) 3... Qh4#";

function rootOf(movetext: string, fen = FEN) {
    const text = `[SetUp "1"]\n[FEN "${fen}"]\n\n${movetext} *\n`;
    return readGame(text, 0)!.root;
}

test("tags: trimmed, split on commas, once ignoring case", () => {
    expect(normalizeTags(["matto, Inchiodatura ", "MATTO", "  doppio   attacco"])).toEqual([
        "matto",
        "Inchiodatura",
        "doppio attacco",
    ]);
});

test("a tactic saved in a collection is read back as it was", () => {
    const root = rootOf("2... Qh4#");
    const one = tacticPgn({ collection: "Libro", id: "t-1", tags: ["matto"], root });
    const two = tacticPgn({ collection: "Libro", id: "t-2", tags: [], root: rootOf(MOVES) });
    const text = appendTactic(appendTactic(null, one), two);
    const tactics = parseCollection(text, "Libro", "/x/Libro.pgn");
    expect(tactics.map((t) => t.id)).toEqual(["t-1", "t-2"]);
    expect(tactics[0]).toMatchObject({
        color: "black",
        tags: ["matto"],
        line: ["Qh4#"],
        game: 0,
    });
    expect(tactics[1].line).toEqual(["d5", "h3", "Qh4#"]);
    expect(text).toContain('[Orientation "black"]');
    expect(text).toMatch(/\(3\. Bg2\s+Qh4\+\)/);
    expect(text).toContain("{Apre la diagonale}");
});

test("solving: only the main line; a reply follows each right move; two misses fail", () => {
    const [tactic] = parseCollection(
        tacticPgn({ collection: "L", id: "a", tags: [], root: rootOf(MOVES) }),
        "L",
        "f",
    );
    let a = answer(tactic, newAttempt(), "d5");
    expect(a).toMatchObject({ ply: 2, state: "playing", missed: false });
    a = answer(tactic, a, "Qg5");
    expect(a).toMatchObject({ ply: 2, misses: 1, state: "playing", missed: true });
    a = answer(tactic, a, "Qh4#");
    expect(a).toMatchObject({ ply: 3, state: "solved", missed: true });
    let b = answer(tactic, newAttempt(), "Qh4+");
    b = answer(tactic, b, "e4");
    expect(b.state).toBe("failed");
    expect(giveUp(newAttempt())).toMatchObject({ state: "failed", missed: true });
    // A solution ending with the reply: solved with your last move.
    const [short] = parseCollection(
        tacticPgn({ collection: "L", id: "b", tags: [], root: rootOf("2... d5 3. h3") }),
        "L",
        "f",
    );
    expect(answer(short, newAttempt(), "d5").state).toBe("solved");
});

test("choosing by collections and tags", () => {
    const make = (collection: string, tags: string[]) => ({
        ...parseCollection(
            tacticPgn({ collection, id: collection + tags.join(), tags, root: rootOf(MOVES) }),
            collection,
            "f",
        )[0],
    });
    const all = [
        make("A", ["matto"]),
        make("A", ["inchiodatura"]),
        make("B", ["Matto", "deviazione"]),
    ];
    expect(selectTactics(all, [], ["matto"]).length).toBe(2);
    expect(selectTactics(all, ["A"], []).length).toBe(2);
    expect(selectTactics(all, ["B"], ["matto", "deviazione"]).length).toBe(1);
    expect(tagsOf(all)).toEqual(["matto", "deviazione", "inchiodatura"]);
});

test("the solution for display: numbers, glyphs, comments, variations", () => {
    const parts = solutionParts(rootOf(MOVES));
    const text = (ps: typeof parts): string =>
        ps
            .map((p) =>
                p.kind === "move"
                    ? `${p.label}${p.san}`
                    : p.kind === "comment"
                      ? `{${p.text}}`
                      : `(${text(p.parts)})`,
            )
            .join(" ");
    expect(text(parts)).toBe("2...d5! {Apre la diagonale} 3.h3 (3.Bg2 Qh4+) 3...Qh4#");
});
