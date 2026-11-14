// History of the repertoire edits made on the phone, kept in the repository
// (training/edits.json) so the PC can list them and undo any of them.

import type { SyncDoc } from "@/utils/sync/engine";
import type { RepertoireOp } from "./repertoireEdit";
import { stableJson } from "./training/trainingDocs";

export const EDIT_HISTORY_PATH = "training/edits.json";

export type EditEntry = {
    id: string;
    /** ISO time of the edit. */
    at: string;
    device: "phone" | "pc";
    /** PGN path relative to repertoires/ and game index in the file. */
    rel: string;
    game: number;
    op: RepertoireOp;
    /** The edit that undoes it. */
    inverse: RepertoireOp;
    /** What changed, in words ("Aggiunta 7.Dd2 dopo 6...O-O"). */
    summary: string;
    /** When it was undone (on the PC). */
    undoneAt?: string;
};

export type EditHistory = { version: 1; entries: EditEntry[] };

export function emptyHistory(): EditHistory {
    return { version: 1, entries: [] };
}

export function parseHistory(text: string | null): EditHistory {
    if (!text) return emptyHistory();
    try {
        const parsed = JSON.parse(text) as Partial<EditHistory>;
        return { version: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
    } catch {
        return emptyHistory();
    }
}

/** Union by id (oldest first); an entry undone on either side stays undone. */
export function mergeHistory(a: EditHistory, b: EditHistory): EditHistory {
    const byId = new Map<string, EditEntry>();
    for (const entry of [...a.entries, ...b.entries]) {
        const known = byId.get(entry.id);
        if (!known) {
            byId.set(entry.id, entry);
        } else if (!known.undoneAt && entry.undoneAt) {
            byId.set(entry.id, { ...known, undoneAt: entry.undoneAt });
        }
    }
    const entries = [...byId.values()].sort(
        (x, y) => x.at.localeCompare(y.at) || x.id.localeCompare(y.id),
    );
    return { version: 1, entries };
}

export function mergeHistoryText(local: string | null, remote: string | null): string | null {
    if (!local && !remote) return null;
    if (!remote) return local;
    if (!local) return remote;
    return stableJson(mergeHistory(parseHistory(local), parseHistory(remote)));
}

export type HistoryStore = {
    read(): string | null;
    write(text: string): void;
};

export function editHistoryDoc(store: HistoryStore): SyncDoc {
    return {
        path: EDIT_HISTORY_PATH,
        read: store.read,
        write: store.write,
        merge: mergeHistoryText,
        upload: true,
    };
}

export function newEntryId(now = new Date()): string {
    return `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Words for an edit
// ---------------------------------------------------------------------------

/** "7.Qd2" / "6...O-O": the last move of `line` with its number. */
export function moveLabel(line: readonly string[], startHalfMoves = 0): string {
    if (line.length === 0) return "";
    const ply = startHalfMoves + line.length - 1;
    const n = Math.floor(ply / 2) + 1;
    const san = line[line.length - 1];
    return ply % 2 === 0 ? `${n}.${san}` : `${n}...${san}`;
}

/** Summary of an edit for the history list. */
export function describeOp(
    op: RepertoireOp,
    startHalfMoves = 0,
    extra?: { moves?: number },
): string {
    const move = moveLabel(op.line, startHalfMoves);
    const after =
        op.line.length > 1
            ? ` dopo ${moveLabel(op.line.slice(0, -1), startHalfMoves)}`
            : " all'inizio";
    switch (op.kind) {
        case "add":
            return `Aggiunta ${move}${after}`;
        case "delete":
            return extra?.moves && extra.moves > 1
                ? `Eliminata ${move} (e le ${extra.moves - 1} mosse seguenti)`
                : `Eliminata ${move}`;
        case "restore":
            return `Rimessa ${move}`;
        case "promote":
            return `${move} diventa la mossa principale`;
        case "comment":
            if (op.line.length === 0) return "Idee della sezione modificate";
            return op.text ? `Commento a ${move}: «${op.text}»` : `Commento a ${move} cancellato`;
        case "nags":
            return op.nags.length
                ? `Simboli di ${move}: ${op.nags.join(" ")}`
                : `Simboli di ${move} tolti`;
    }
}
