import { Chess } from "chessops/chess";
import { makeFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { expect, test } from "vitest";
import { buildIndex, lookup, nameTokens, placeIn, suggest } from "../repertoireLookup";

const black = (moves: string) => `[Orientation "black"]\n\n${moves} *\n`;
const white = (moves: string) => `[Orientation "white"]\n\n${moves} *\n`;

const index = buildIndex([
    {
        path: "/r/Caro Kann/Exchange Variation.pgn",
        label: "Caro Kann · Exchange Variation",
        group: "Caro Kann",
        name: "Exchange Variation",
        text: black("1. e4 c6 2. d4 d5 3. exd5 cxd5 4. Nf3 Nc6 (4... Bg4) 5. Bb5"),
    },
    {
        path: "/r/Caro Kann/Advance Variation.pgn",
        label: "Caro Kann · Advance Variation",
        group: "Caro Kann",
        name: "Advance Variation",
        text: black("1. e4 c6 2. d4 d5 3. e5 Bf5"),
    },
    {
        path: "/r/Siciliana/Rossolimo.pgn",
        label: "Siciliana · Rossolimo",
        group: "Siciliana",
        name: "Rossolimo",
        text: black("1. e4 c5 2. Nf3 Nc6 3. Bb5 g6"),
    },
    {
        path: "/r/Scotch.pgn",
        label: "Scotch",
        group: "",
        name: "Scotch",
        text: white("1. e4 e5 2. Nf3 Nc6 3. d4"),
    },
]);

function line(sans: string) {
    const pos = Chess.default();
    const fens = [makeFen(pos.toSetup())];
    const list = sans.split(" ").filter(Boolean);
    for (const s of list) {
        pos.play(parseSan(pos, s)!);
        fens.push(makeFen(pos.toSetup()));
    }
    return { fens, sans: list };
}

const last = (l: { fens: string[] }) => l.fens[l.fens.length - 1];

test("a position is found by any move order, in the repertoires of the colour", () => {
    // Exchange Variation reached with 2.Nf3 ... 4.d4.
    const l = line("e4 c6 Nf3 d5 exd5 cxd5 d4");
    const found = lookup(index, last(l), "black");
    expect(found.map((o) => o.file.name)).toEqual(["Exchange Variation"]);
    expect(found[0]).toMatchObject({
        moves: ["Nc6", "Bg4"],
        yours: true,
        line: ["e4", "c6", "d4", "d5", "exd5", "cxd5", "Nf3"],
    });
    expect(lookup(index, last(l), "white")).toEqual([]);
    // The opponent's turn: the replies prepared.
    expect(lookup(index, last(line("e4 c6 d4 d5 exd5 cxd5 Nf3 Nc6")), "black")[0]).toMatchObject({
        moves: ["Bb5"],
        yours: false,
    });
});

test("names: Italian file names meet the openings' English names", () => {
    expect(nameTokens("Siciliana Rossolimo")).toEqual(["sicilian", "rossolimo"]);
    expect(nameTokens("Sicilian Defense: Nyezhmetdinov-Rossolimo Attack")).toEqual([
        "sicilian",
        "nyezhmetdinov",
        "rossolimo",
        "attack",
    ]);
    expect(nameTokens("Est Indiana · Altre varianti")).toEqual(["kings", "indian"]);
    expect(nameTokens("King's Indian Defense")).toEqual(["kings", "indian"]);
});

test("a new line goes where it shares most, with the name; only the missing moves are added", () => {
    const l = line("e4 c6 d4 d5 exd5 cxd5 Nf3 Nc6 Bb5 a6");
    const [best, second] = suggest(index, l, "Caro-Kann Defense: Exchange Variation", "black", {});
    expect(best.file.name).toBe("Exchange Variation");
    expect(best.missing).toEqual(["a6"]);
    expect(best.addLine).toEqual([
        "e4",
        "c6",
        "d4",
        "d5",
        "exd5",
        "cxd5",
        "Nf3",
        "Nc6",
        "Bb5",
        "a6",
    ]);
    expect(best.reasons.map((r) => r.kind)).toEqual(["shared", "name"]);
    expect(second.file.name).toBe("Advance Variation");
    expect(second.missing).toEqual(["exd5", "cxd5", "Nf3", "Nc6", "Bb5", "a6"]);
    // By transposition: the moves are added after the position as that file reaches it.
    const t = line("e4 c6 Nf3 d5 exd5 cxd5 d4 Nc6 Bb5 a6");
    expect(
        suggest(index, t, "Caro-Kann Defense: Exchange Variation", "black", {})[0].addLine,
    ).toEqual(best.addLine);
});

test("the choice made last time for an opening comes first", () => {
    const l = line("e4 c6 d4 d5 exd5 cxd5 Nf3 Nc6 Bb5 a6");
    const learned = {
        "Caro-Kann Defense: Exchange Variation": "/r/Caro Kann/Advance Variation.pgn",
    };
    const [first] = suggest(index, l, "Caro-Kann Defense: Exchange Variation", "black", learned);
    expect(first.file.name).toBe("Advance Variation");
    expect(first.reasons[0].kind).toBe("learned");
});

test("a repertoire chosen by hand", () => {
    const l = line("e4 c5 Nf3 Nc6 Bb5 g6 O-O");
    const rossolimo = index.files.find((f) => f.name === "Rossolimo")!;
    expect(placeIn(index, rossolimo, l)).toMatchObject({ missing: ["O-O"], game: 0 });
});
