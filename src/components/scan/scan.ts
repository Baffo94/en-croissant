import type { SquareName } from "chessops";
import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import type { ScannedBoard } from "@/bindings";

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp"];

/** Below this, a square is shown as one to check. */
export const DOUBT = 0.9;

const FILES = "abcdefgh";

/** Square name of the i-th square from a8 to h1. */
export function squareAt(i: number): SquareName {
    return `${FILES[i % 8]}${8 - Math.floor(i / 8)}` as SquareName;
}

/** FEN placement of 64 squares from a8 to h1 ('.' empty). */
export function boardFen(squares: string): string {
    const rows: string[] = [];
    for (let r = 0; r < 8; r++) {
        rows.push(squares.slice(r * 8, r * 8 + 8).replace(/\.+/g, (m) => String(m.length)));
    }
    return rows.join("/");
}

function expand(placement: string): string {
    return placement
        .split("/")
        .map((row) => row.replace(/\d/g, (d) => ".".repeat(Number(d))))
        .join("");
}

export function doubtfulSquares(board: ScannedBoard): SquareName[] {
    return board.confidence.flatMap((c, i) => (c < DOUBT ? [squareAt(i)] : []));
}

/** The position turned by 180° (a diagram read the wrong way round). */
export function rotated(placement: string): string {
    return boardFen([...expand(placement)].reverse().join(""));
}

/** Castling allowed where king and rook stand on their squares. */
export function castlingFor(placement: string): string {
    const sq = expand(placement);
    const at = (name: string) => sq[(8 - Number(name[1])) * 8 + FILES.indexOf(name[0])];
    let rights = "";
    if (at("e1") === "K") {
        if (at("h1") === "R") rights += "K";
        if (at("a1") === "R") rights += "Q";
    }
    if (at("e8") === "k") {
        if (at("h8") === "r") rights += "k";
        if (at("a8") === "r") rights += "q";
    }
    return rights || "-";
}

export type PositionProblem = "Invalid" | "Kings" | "PawnsOnBackrank" | "OppositeCheck" | "Empty";

/** Why the position cannot be played or analysed, if it cannot. */
export function positionProblem(fen: string): PositionProblem | null {
    const setup = parseFen(fen);
    if (setup.isErr) return "Invalid";
    const pos = Chess.fromSetup(setup.value);
    if (pos.isOk) return null;
    switch (pos.error.message) {
        case "ERR_EMPTY":
            return "Empty";
        case "ERR_KINGS":
            return "Kings";
        case "ERR_PAWNS_ON_BACKRANK":
            return "PawnsOnBackrank";
        case "ERR_OPPOSITE_CHECK":
            return "OppositeCheck";
        default:
            return "Invalid";
    }
}
