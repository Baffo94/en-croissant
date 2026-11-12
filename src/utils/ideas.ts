// Ideas of a repertoire section: a list of points kept in the PGN as the comment before
// the first move (a Markdown list, so En Croissant shows it as a list too).

const BULLET = /^\s*[-*•]\s+/;

/** The points of an ideas text, one per non-empty line, without bullets. */
export function ideaPoints(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map((l) => l.replace(BULLET, "").trim())
        .filter(Boolean);
}

/** Text typed by the user (one idea per line, bullets optional) as a Markdown list. */
export function ideasText(typed: string): string {
    return ideaPoints(typed)
        .map((p) => `- ${p}`)
        .join("\n");
}

/** Text to edit: one idea per line, without bullets. */
export function ideasDraft(stored: string): string {
    return ideaPoints(stored).join("\n");
}
