// Text helpers for notes on moves (shared by the desktop and the phone).

import type { Note } from "@/utils/sync/core";

const STANDARD_START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** "12. Nf3 Nc6 13. Bb5" — SAN moves with move numbers, starting from `startFen`. */
export function formatLine(startFen: string, line: readonly string[]): string {
    const [, turn, , , , fullText] = startFen.split(" ");
    let full = Number(fullText) || 1;
    let white = turn !== "b";
    const parts: string[] = [];
    line.forEach((san, i) => {
        if (white) parts.push(`${full}.`);
        else if (i === 0) parts.push(`${full}...`);
        parts.push(san);
        if (!white) full++;
        white = !white;
    });
    return parts.join(" ");
}

/** A PGN with the line of a note and the note as the comment of its last move. */
export function notePgn(note: Pick<Note, "startFen" | "line" | "text">): string {
    const headers =
        note.startFen && note.startFen !== STANDARD_START
            ? `[SetUp "1"]\n[FEN "${note.startFen}"]\n\n`
            : "";
    const comment = note.text.replace(/[{}]/g, "");
    return `${headers}${formatLine(note.startFen || STANDARD_START, note.line)} {${comment}} *`;
}
