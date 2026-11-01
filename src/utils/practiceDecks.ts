// Practice decks are stored in localStorage under "deck-<absolute file path>-<game>".
// When a PGN (or a whole folder) is renamed or moved its decks must follow it,
// otherwise the practice progress of that repertoire is silently lost.

import { getDefaultStore } from "jotai";
import type { PracticeData } from "@/components/files/opening";
import { deckAtomFamily } from "@/state/atoms";
import { emptyDeck, mergeDecks, normalizePath, parseDeckKey } from "@/utils/sync/core";

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
