import { expect, test } from "vitest";
import { boardFen, castlingFor, positionProblem, rotated, squareAt } from "../scan";

const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
const squares = "rnbqkbnr" + "pppppppp" + ".".repeat(32) + "PPPPPPPP" + "RNBQKBNR";

test("squares to FEN and back round", () => {
    expect(boardFen(squares)).toBe(start);
    expect(squareAt(0)).toBe("a8");
    expect(squareAt(63)).toBe("h1");
    expect(rotated("4k3/8/8/8/8/8/8/R3K3")).toBe("3K3R/8/8/8/8/8/8/3k4");
    expect(rotated(rotated(start))).toBe(start);
});

test("castling where king and rooks stand at home", () => {
    expect(castlingFor(start)).toBe("KQkq");
    expect(castlingFor("r3k3/8/8/8/8/8/8/4K2R")).toBe("Kq");
    expect(castlingFor("8/8/8/8/8/8/8/k6K")).toBe("-");
});

test("what stops a position from being used", () => {
    expect(positionProblem(`${start} w KQkq - 0 1`)).toBeNull();
    expect(positionProblem("8/8/8/8/8/8/8/8 w - - 0 1")).toBe("Empty");
    expect(positionProblem("8/8/8/8/8/8/8/4K3 w - - 0 1")).toBe("Kings");
    // Black in check with White to move: it is Black's turn.
    expect(positionProblem("3Rk3/8/8/8/8/8/8/4K3 w - - 0 1")).toBe("OppositeCheck");
    expect(positionProblem("3Rk3/8/8/8/8/8/8/4K3 b - - 0 1")).toBeNull();
});
