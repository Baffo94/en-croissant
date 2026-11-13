/** "7. Ae2" / "7... Te8": a move with its number, `ply` counted from the start position (1 = first move). */
export function numbered(startFen: string, ply: number, san: string): string {
    const parts = startFen.split(" ");
    const blackFirst = parts[1] === "b";
    const fullmove = Number(parts[5]) || 1;
    const index = ply - 1 + (blackFirst ? 1 : 0); // half-moves from White's first move of fullmove
    const n = fullmove + Math.floor(index / 2);
    return index % 2 === 0 ? `${n}. ${san}` : `${n}... ${san}`;
}
