// Practice decks are stored in localStorage under "deck-<absolute file path>-<game>".
// When a PGN (or a whole folder) is renamed or moved its decks must follow it,
// otherwise the practice progress of that repertoire is silently lost.

import { getDefaultStore, useAtomValue } from "jotai";
import { atomFamily, atomWithStorage } from "jotai/utils";
import type { PracticeData } from "@/components/files/opening";
import { deckAtomFamily } from "@/state/atoms";
import {
    emptyDeck,
    isPaused,
    mergeDecks,
    liveNotes,
    type Note,
    normalizePath,
    parseDeckKey,
    type PauseState,
} from "@/utils/sync/core";

// ---------------------------------------------------------------------------
// Paused repertoires: "repertoire-pause-<normalised path>" -> PauseState
// ---------------------------------------------------------------------------

const PAUSE_PREFIX = "repertoire-pause-";

const pauseAtomFamily = atomFamily((normalizedPath: string) =>
    atomWithStorage<PauseState | null>(`${PAUSE_PREFIX}${normalizedPath}`, null, undefined, {
        getOnInit: true,
    }),
);

/** Atom holding the pause state of a repertoire (to subscribe to several at once). */
export function pauseAtomOf(path: string) {
    return pauseAtomFamily(normalizePath(path));
}

export function getPause(path: string): PauseState | null {
    return getDefaultStore().get(pauseAtomFamily(normalizePath(path)));
}

export function setPauseState(path: string, state: PauseState | null): void {
    const atom = pauseAtomFamily(normalizePath(path));
    if (state) getDefaultStore().set(atom, state);
    else {
        getDefaultStore().set(atom, null);
        localStorage.removeItem(`${PAUSE_PREFIX}${normalizePath(path)}`);
    }
}

/** Pauses or resumes a repertoire (the review schedule is left as it is). */
export function setPaused(path: string, paused: boolean): void {
    setPauseState(path, { paused, changedAt: new Date().toISOString() });
}

export function isRepertoirePaused(path: string): boolean {
    return isPaused(getPause(path));
}

/** Reactive version of isRepertoirePaused, for components. */
export function usePaused(path: string): boolean {
    return isPaused(useAtomValue(pauseAtomFamily(normalizePath(path))));
}

// ---------------------------------------------------------------------------
// Notes on moves: "repertoire-notes-<normalised path>" -> Note[] (deleted ones included)
// ---------------------------------------------------------------------------

const NOTES_PREFIX = "repertoire-notes-";

const notesAtomFamily = atomFamily((normalizedPath: string) =>
    atomWithStorage<Note[]>(`${NOTES_PREFIX}${normalizedPath}`, [], undefined, {
        getOnInit: true,
    }),
);

export function notesAtomOf(path: string) {
    return notesAtomFamily(normalizePath(path));
}

/** All notes of a repertoire, deleted ones included (for the sync). */
export function getNotes(path: string): Note[] {
    return getDefaultStore().get(notesAtomFamily(normalizePath(path)));
}

export function setNotes(path: string, notes: Note[]): void {
    const atom = notesAtomFamily(normalizePath(path));
    getDefaultStore().set(atom, notes);
    if (notes.length === 0) localStorage.removeItem(`${NOTES_PREFIX}${normalizePath(path)}`);
}

/** Notes shown for a repertoire (not deleted), reactive. */
export function useNotes(path: string): Note[] {
    return liveNotes(useAtomValue(notesAtomFamily(normalizePath(path))));
}

/** Deletes a note everywhere: a tombstone that the sync takes to the other devices. */
export function deleteNote(path: string, id: string): void {
    const now = new Date().toISOString();
    setNotes(
        path,
        getNotes(path).map((n) =>
            n.id === id ? { ...n, deleted: true, text: "", updated: now } : n,
        ),
    );
}

/** Moves values stored per path (pauses, notes) of a renamed file or folder. */
function moveStored<T>(
    prefix: string,
    family: (path: string) => ReturnType<typeof atomWithStorage<T>>,
    empty: T,
    from: string,
    to: string,
) {
    const source = normalizePath(from);
    const dest = normalizePath(to);
    const moves: [string, string][] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(prefix)) continue;
        const file = key.slice(prefix.length);
        if (file === source) moves.push([file, dest]);
        else if (file.startsWith(`${source}/`))
            moves.push([file, `${dest}${file.slice(source.length)}`]);
    }
    const store = getDefaultStore();
    for (const [oldFile, newFile] of moves) {
        const value = store.get(family(oldFile));
        store.set(family(newFile), value);
        store.set(family(oldFile), empty);
        localStorage.removeItem(`${prefix}${oldFile}`);
    }
}

function movePauses(from: string, to: string) {
    moveStored<PauseState | null>(PAUSE_PREFIX, pauseAtomFamily, null, from, to);
    moveStored<Note[]>(NOTES_PREFIX, notesAtomFamily, [], from, to);
}

function readDeck(key: string): PracticeData | null {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const deck = JSON.parse(raw) as PracticeData;
        return Array.isArray(deck?.positions) && Array.isArray(deck?.logs) ? deck : null;
    } catch {
        return null;
    }
}

/**
 * Moves the decks of `from` to `to`. Works for a single PGN file or for a folder
 * (every PGN inside it). Decks already present at the destination are merged.
 * Returns the number of decks moved.
 */
export function moveDecks(from: string, to: string): number {
    movePauses(from, to);
    const source = normalizePath(from);
    const sep = to.includes("\\") ? "\\" : "/";
    const destRoot = to.replace(/[\\/]+$/, "");
    const store = getDefaultStore();

    const moves: { key: string; file: string; game: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        const parsed = key ? parseDeckKey(key) : null;
        if (!key || !parsed) continue;
        const file = normalizePath(parsed.file);
        if (file === source) {
            moves.push({ key, file: destRoot, game: parsed.game });
        } else if (file.startsWith(`${source}/`)) {
            // Keep the original spelling of the part below the moved folder.
            const rest = parsed.file
                .replace(/\\/g, "/")
                .slice(source.length + 1)
                .split("/")
                .join(sep);
            moves.push({ key, file: `${destRoot}${sep}${rest}`, game: parsed.game });
        }
    }

    let moved = 0;
    for (const { key, file, game } of moves) {
        const deck = readDeck(key);
        if (!deck) continue;
        const atom = deckAtomFamily({ file, game });
        const existing = readDeck(`deck-${file}-${game}`);
        const merged = existing ? mergeDecks(existing, deck) : mergeDecks(emptyDeck(), deck);
        localStorage.removeItem(key);
        store.set(atom, merged);
        moved++;
    }
    return moved;
}

/** All practice decks of a PGN file, keyed by game index. */
export function decksOfFile(path: string): Record<number, PracticeData> {
    const target = normalizePath(path);
    const decks: Record<number, PracticeData> = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        const parsed = key ? parseDeckKey(key) : null;
        if (!key || !parsed || normalizePath(parsed.file) !== target) continue;
        const deck = readDeck(key);
        if (deck && (!decks[parsed.game] || deck.logs.length > decks[parsed.game].logs.length)) {
            decks[parsed.game] = deck;
        }
    }
    return decks;
}

/** Deletes the practice decks of a PGN file (e.g. when the file is deleted). */
export function removeDecks(path: string): void {
    setPauseState(path, null);
    setNotes(path, []);
    const target = normalizePath(path);
    const store = getDefaultStore();
    const keys: { key: string; file: string; game: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        const parsed = key ? parseDeckKey(key) : null;
        if (key && parsed && normalizePath(parsed.file) === target) keys.push({ key, ...parsed });
    }
    for (const { key, file, game } of keys) {
        store.set(deckAtomFamily({ file, game }), emptyDeck());
        localStorage.removeItem(key);
    }
}
