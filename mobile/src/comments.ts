// Repertoire edits made on the phone: moves added or deleted, main line changed,
// comments and symbols. The PGN text is changed as the PC would change it (only the
// edited game is rewritten) and uploaded by the sync. Pending edits are remembered until
// GitHub has them: if the PC changed the same file meanwhile they are applied again on
// top of the PC's version (every edit is idempotent). Each edit also goes into the
// shared history (training/edits.json), from which the PC can undo it.

import {
    describeOp,
    type EditEntry,
    type HistoryStore,
    mergeHistory,
    newEntryId,
    parseHistory,
} from "@/utils/editHistory";
import { getMoveComment } from "@/utils/pgnEdit";
import { applyOp, countMoves, nodeAt, readGame, type RepertoireOp } from "@/utils/repertoireEdit";
import { stableJson } from "@/utils/training/trainingDocs";
import { decodeBase64, encodeBase64, getState, type PendingEdit, updateState } from "./state";
import { scheduleSync } from "./sync";

const EDIT_SYNC_DELAY = 3_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export function readText(rel: string): string | null {
    const b64 = getState().files[rel];
    return b64 === undefined ? null : decoder.decode(decodeBase64(b64));
}

/** Edits not yet confirmed on GitHub (comment edits of older versions included). */
function pendingOf(state: ReturnType<typeof getState>): Record<string, PendingEdit[]> {
    const out: Record<string, PendingEdit[]> = {};
    for (const [rel, edits] of Object.entries(state.commentEdits ?? {})) {
        out[rel] = edits.map((e) => ({
            game: e.game,
            op: { kind: "comment", line: e.line, text: e.text },
        }));
    }
    for (const [rel, edits] of Object.entries(state.repertoireEdits ?? {})) {
        out[rel] = [...(out[rel] ?? []), ...edits];
    }
    return out;
}

/** The game's own comment (the ideas of a section), "" when none. */
export function getGameComment(rel: string, game: number): string {
    const text = readText(rel);
    return text === null ? "" : getMoveComment(text, game, []);
}

/**
 * Applies an edit to game `game` of `rel`: the file changes here at once, the edit is
 * remembered for the sync and written in the history. Returns the id of the history
 * entry, or null when it changes nothing (move already there, not found...).
 */
export function editRepertoire(rel: string, game: number, op: RepertoireOp): string | null {
    const current = readText(rel);
    if (current === null) return null;
    const before = readGame(current, game);
    const removed = op.kind === "delete" && before ? nodeAt(before.root, op.line) : null;
    const result = applyOp(current, game, op);
    if (!result.changed || !result.inverse) return null;
    const now = new Date();
    const entry: EditEntry = {
        id: newEntryId(now),
        at: now.toISOString(),
        device: "phone",
        rel,
        game,
        op,
        inverse: result.inverse,
        summary: describeOp(op, before?.root.halfMoves ?? 0, {
            moves: removed ? countMoves(removed) : undefined,
        }),
    };
    updateState((s) => {
        const pending = pendingOf(s);
        const history = mergeHistory(s.editHistory ?? { version: 1, entries: [] }, {
            version: 1,
            entries: [entry],
        });
        return {
            ...s,
            files: { ...s.files, [rel]: encodeBase64(encoder.encode(result.text)) },
            commentEdits: {},
            repertoireEdits: {
                ...pending,
                [rel]: [...(pending[rel] ?? []), { game, op, id: entry.id }],
            },
            editHistory: history,
        };
    });
    scheduleSync(EDIT_SYNC_DELAY);
    return entry.id;
}

/** Sets the comment of the move reached by `line` (SAN from the start of the game). */
export function setComment(rel: string, game: number, line: string[], text: string): boolean {
    const current = readText(rel);
    if (current === null || !readGame(current, game)) return false;
    // An unchanged comment is fine too (nothing to save).
    return (
        editRepertoire(rel, game, { kind: "comment", line, text }) !== null ||
        hasMove(current, game, line)
    );
}

function hasMove(text: string, game: number, line: string[]): boolean {
    const read = readGame(text, game);
    return !!read && nodeAt(read.root, line) !== null;
}

/** Applies `edits` to the PGN text; edits whose move no longer exists are skipped. */
export function applyEdits(text: string, edits: readonly PendingEdit[]): string {
    let out = text;
    for (const e of edits) out = applyOp(out, e.game, e.op).text;
    return out;
}

/** Files with edits not yet on GitHub. */
export function pendingFiles(): Set<string> {
    const edits = pendingOf(getState());
    return new Set(Object.keys(edits).filter((rel) => edits[rel].length > 0));
}

/**
 * After a sync: applies again the edits the downloaded version lacks (returns true when
 * a file changed, so another sync uploads it) and forgets the edits GitHub has.
 */
export async function settleEdits(
    remoteShas: Record<string, string>,
    localSha: (rel: string) => Promise<string>,
): Promise<boolean> {
    const all = pendingOf(getState());
    let changed = false;
    const keep: Record<string, PendingEdit[]> = {};
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
    updateState((s) => ({ ...s, commentEdits: {}, repertoireEdits: keep }));
    return changed;
}

/** The history document as the sync sees it. */
export const phoneHistoryStore: HistoryStore = {
    read: () => {
        const history = getState().editHistory;
        return history && history.entries.length > 0 ? stableJson(history) : null;
    },
    write: (text) => {
        updateState((s) => ({ ...s, editHistory: parseHistory(text) }));
    },
};

/**
 * Undoes an edit made here (the "Annulla" right after it): its inverse is applied like
 * any other edit and the entry is marked undone in the history.
 */
export function undoEdit(id: string): boolean {
    const entry = getState().editHistory?.entries.find((e) => e.id === id);
    if (!entry || entry.undoneAt) return false;
    const current = readText(entry.rel);
    if (current === null) return false;
    const result = applyOp(current, entry.game, entry.inverse);
    const now = new Date().toISOString();
    const wasPending = (pendingOf(getState())[entry.rel] ?? []).some((e) => e.id === id);
    updateState((s) => {
        const pending = pendingOf(s);
        const entries = (s.editHistory?.entries ?? []).map((e) =>
            e.id === id ? { ...e, undoneAt: now } : e,
        );
        return {
            ...s,
            files: result.changed
                ? { ...s.files, [entry.rel]: encodeBase64(encoder.encode(result.text)) }
                : s.files,
            commentEdits: {},
            repertoireEdits: {
                ...pending,
                // Not on GitHub yet: the edit is simply forgotten (replaying it and then
                // its inverse on top of a version changed on the PC could undo changes
                // made there). Otherwise its inverse goes up like any other edit.
                [entry.rel]: wasPending
                    ? (pending[entry.rel] ?? []).filter((e) => e.id !== id)
                    : result.changed
                      ? [...(pending[entry.rel] ?? []), { game: entry.game, op: entry.inverse }]
                      : (pending[entry.rel] ?? []),
            },
            editHistory: { version: 1, entries },
        };
    });
    scheduleSync(EDIT_SYNC_DELAY);
    return result.changed;
}
