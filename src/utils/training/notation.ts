/** Moves with their numbers, from a start position: "1. Kd2 Kc4 2. Ke2" or "1... Kb5 2. Kc3". */
export function numberedMoves(startFen: string, sans: readonly string[]): string {
    const parts = startFen.split(" ");
    let n = Number(parts[5]) || 1;
    let white = parts[1] !== "b";
    const out: string[] = [];
    sans.forEach((san, i) => {
        if (white) out.push(`${n}. ${san}`);
        else out.push(i === 0 ? `${n}... ${san}` : san);
        if (!white) n++;
        white = !white;
    });
    return out.join(" ");
}
