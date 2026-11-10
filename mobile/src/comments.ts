// Comments of repertoire moves edited on the phone. The PGN text is changed in place
// (only that comment), exactly like a comment written on the PC, and uploaded by the
// sync. Edits are remembered until GitHub has them, so that if the PC changed the same
// file meanwhile they are applied again on top of the PC's version.

import { setMoveComment } from "@/utils/pgnEdit";
import { type CommentEdit, encodeBase64, decodeBase64, getState, updateState } from "./state";
import { scheduleSync } from "./sync";

const COMMENT_SYNC_DELAY = 3_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

function readText(rel: string): string | null {
    const b64 = getState().files[rel];
    return b64 === undefined ? null : decoder.decode(decodeBase64(b64));
}

/** Applies `edits` to the PGN text; edits whose move no longer exists are skipped. */
export function applyEdits(text: string, edits: readonly CommentEdit[]): string {
    let out = text;
    for (const e of edits) out = setMoveComment(out, e.game, e.line, e.text) ?? out;
    return out;
}

/** Sets the comment of the move reached by `line` (SAN from the start of the game). */
export function setComment(rel: string, game: number, line: string[], text: string): boolean {
    const current = readText(rel);
    if (current === null) return false;
    const next = setMoveComment(current, game, line, text);
    if (next === null) return false;
    const key = line.join(" ");
    updateState((s) => {
        const edits = (s.commentEdits?.[rel] ?? []).filter(
            (e) => !(e.game === game && e.line.join(" ") === key),
        );
        return {
            ...s,
            files: { ...s.files, [rel]: encodeBase64(encoder.encode(next)) },
            commentEdits: { ...s.commentEdits, [rel]: [...edits, { game, line, text }] },
        };
    });
    scheduleSync(COMMENT_SYNC_DELAY);
    return true;
}

/** Files with comments not yet on GitHub. */
export function pendingFiles(): Set<string> {
    const edits = getState().commentEdits ?? {};
    return new Set(Object.keys(edits).filter((rel) => edits[rel].length > 0));
}

/**
 * After a sync: applies again the edits the downloaded version lacks (returns true when
 * a file changed, so another sync uploads it) and forgets the edits GitHub has.
 */
export function settleEdits(
    remoteShas: Record<string, string>,
    localSha: (rel: string) => Promise<string>,
): Promise<boolean> {
    return (async () => {
        const all = getState().commentEdits ?? {};
        let changed = false;
        const keep: Record<string, CommentEdit[]> = {};
        for (const [rel, edits] of Object.entries(all)) {
            if (edits.length === 0) continue;
            const text = readText(rel);
            if (text === null) continue; // file deleted on the PC: nothing to apply
            const applied = applyEdits(text, edits);
            if (applied !== text) {
                updateState((s) => ({
                    ...s,
                    files: { ...s.files, [rel]: encodeBase64(encoder.encode(applied)) },
                }));
                changed = true;
                keep[rel] = edits;
            } else if (remoteShas[rel] !== (await localSha(rel))) {
                keep[rel] = edits; // not uploaded yet
            }
        }
        updateState((s) => ({ ...s, commentEdits: keep }));
        return changed;
    })();
}
