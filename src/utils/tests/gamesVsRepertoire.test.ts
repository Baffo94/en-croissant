import { describe, expect, test } from "vitest";
import {
    compareGames,
    movesOfPgn,
    normaliseMoves,
    type StoredGame,
} from "@/utils/gamesVsRepertoire";

const scotch = {
    path: "/r/Scotch/Main.pgn",
    label: "Scotch · Main",
    text: `[Orientation "white"]\n\n1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Nf6 (4... Bc5 5. Nb3) 5. Nxc6 bxc6 6. e5 *`,
};
const caro = {
    path: "/r/Caro.pgn",
    label: "Caro",
    text: `[Orientation "black"]\n\n1. e4 c6 2. d4 (2. Nf3 d5 3. d4) 2... d5 3. e5 (3. exd5 cxd5) (3. Nf3 Bg4) 3... Bf5 *`,
};

let n = 0;
function game(
    moves: string,
    myColor: "white" | "black",
    result: StoredGame["result"] = "win",
): StoredGame {
    return {
        id: String(n++),
        source: "chesscom",
        account: "me",
        url: "https://www.chess.com/game/live/1",
        date: 1_700_000_000_000 + n,
        speed: "rapid",
        myColor,
        opponent: "x",
        result,
        moves: normaliseMoves(moves.split(" ")),
    };
}

describe("games against the repertoire", () => {
    test("deviation: you played another move in a prepared position", () => {
        const { outcomes, problems } = compareGames(
            [scotch, caro],
            [game("e4 e5 Nf3 Nc6 d4 exd4 Bc4 Nf6", "white")],
        );
        expect(outcomes[0]).toMatchObject({
            status: "deviation",
            played: "Bc4",
            prepared: ["Nxd4"],
            bookPlies: 6,
        });
        expect(problems[0]).toMatchObject({
            kind: "deviation",
            label: "Scotch · Main",
            played: "Bc4",
        });
        expect(problems[0].line).toEqual(["e4", "e5", "Nf3", "Nc6", "d4", "exd4"]);
    });

    test("hole: the opponent played a move you have not prepared", () => {
        const { outcomes } = compareGames(
            [scotch, caro],
            [game("e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Qf6 Nb5", "white")],
        );
        expect(outcomes[0]).toMatchObject({
            status: "hole",
            played: "Qf6",
            prepared: ["Nf6", "Bc5"],
        });
    });

    test("end of the preparation is not a problem; alternatives in the PGN are fine", () => {
        const { outcomes } = compareGames(
            [scotch, caro],
            [
                game("e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nxc6 bxc6 e5 Qe7 Qe2", "white"),
                game("e4 c6 d4 d5 exd5 cxd5 c4 Nf6", "black"),
            ],
        );
        expect(outcomes.map((o) => [o.status, o.bookPlies])).toEqual([
            ["end", 11],
            ["end", 6],
        ]);
    });

    test("transpositions are followed", () => {
        // 1.Nf3 c6 2.e4 d5 reaches the Caro-Kann position after 2.Nf3 d5 by another order.
        const { outcomes } = compareGames(
            [scotch, caro],
            [game("e4 c6 Nf3 d5 d4 Bg4 h3", "black")],
        );
        expect(outcomes[0]).toMatchObject({ status: "end", bookPlies: 6, label: "Caro" });
    });

    test("games outside every repertoire, grouping and section results", () => {
        const games = [
            game("d4 d5", "white", "loss"), // 1.d4: deviation at the first move
            game("e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Qf6", "white", "loss"),
            game("e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Qf6", "white", "draw"),
            game("c4 e5", "black"), // 1.c4 against a black repertoire for 1.e4: hole
            game("e4 e5", "black"), // black repertoire answers 1.e4 c6: deviation
        ];
        const { outcomes, problems, sections } = compareGames([scotch, caro], games);
        expect(outcomes.map((o) => o.status)).toEqual([
            "deviation",
            "hole",
            "hole",
            "hole",
            "deviation",
        ]);
        expect(problems[0]).toMatchObject({ kind: "hole", played: "Qf6" });
        expect(problems[0].games.length).toBe(2);
        const s = sections.find((x) => x.label === "Scotch · Main")!;
        expect(s).toMatchObject({ games: 3, points: 0.5 });
    });

    test("PGN of a downloaded game", () => {
        expect(
            movesOfPgn(`[Event "x"]\n\n1. e4 e5 2. Nf3 {[%clk 0:09:58]} Nc6 3. Bb5 1-0`),
        ).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5"]);
        expect(
            movesOfPgn(
                `[Variant "Chess960"]\n[FEN "bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w KQkq - 0 1"]\n\n1. e4 *`,
            ),
        ).toBeNull();
    });
});
