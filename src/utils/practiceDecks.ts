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

/** Moves pause states of a renamed file or folder. */
function movePauses(from: string, to: string) {
    const source = normalizePath(from);
    const dest = normalizePath(to);
    const moves: [string, string][] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(PAUSE_PREFIX)) continue;
        const file = key.slice(PAUSE_PREFIX.length);
        if (file === source) moves.push([file, dest]);
        else if (file.startsWith(`${source}/`))
            moves.push([file, `${dest}${file.slice(source.length)}`]);
    }
    const store = getDefaultStore();
    for (const [oldFile, newFile] of moves) {
        const state = store.get(pauseAtomFamily(oldFile));
        store.set(pauseAtomFamily(newFile), state);
        store.set(pauseAtomFamily(oldFile), null);
        localStorage.removeItem(`${PAUSE_PREFIX}${oldFile}`);
    }
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
