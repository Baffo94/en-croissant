// "Train all": one practice session over the due positions of every repertoire,
// shuffled. The session runs in a normal analysis tab (see PracticePanel), which
// loads the repertoire of each position as the session goes.

import { getDefaultStore } from "jotai";
import { commands } from "@/bindings";
import { buildFromTree, type PracticeData, syncDeck } from "@/components/files/opening";
import { deckAtomFamily } from "@/state/atoms";
import { parsePGN } from "@/utils/chess";
import { decksOfFile } from "@/utils/practiceDecks";
import { unwrap } from "@/utils/unwrap";

export type MixedFile = { path: string; name: string };
export type MixedItem = { path: string; fen: string };

export function shuffle<T>(items: T[]): T[] {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/** Due (and new) positions of the given decks, shuffled. */
export function dueItems(decks: Record<string, PracticeData>, now = new Date()): MixedItem[] {
    const items: MixedItem[] = [];
    for (const [path, deck] of Object.entries(decks)) {
        for (const p of deck.positions)
            if (new Date(p.card.due) <= now) items.push({ path, fen: p.fen });
    }
    return shuffle(items);
}

/** Reads the current decks (first game of each file) from storage. */
export function currentDecks(files: MixedFile[]): Record<string, PracticeData> {
    const decks: Record<string, PracticeData> = {};
    for (const file of files) {
        const deck = decksOfFile(file.path)[0];
        if (deck) decks[file.path] = deck;
    }
    return decks;
}

/**
 * Brings the deck of every repertoire in line with its PGN (as the practice panel
 * does when a repertoire is opened) and returns the shuffled queue of due positions.
 */
export async function prepareMixedSession(files: MixedFile[]): Promise<MixedItem[]> {
    const store = getDefaultStore();
    const decks: Record<string, PracticeData> = {};
    for (const file of files) {
        try {
            const pgn = unwrap(await commands.readGames(file.path, 0, 0))[0] ?? "";
            const tree = await parsePGN(pgn);
            const orientation = tree.headers.orientation === "black" ? "black" : "white";
            const start = tree.headers.start ?? [];
            const existing = decksOfFile(file.path)[0];
            let deck: PracticeData;
            if (!existing || existing.positions.length === 0) {
                deck = {
                    positions: buildFromTree(tree.root, orientation, start),
                    logs: existing?.logs ?? [],
                };
                if (deck.positions.length > 0)
                    store.set(deckAtomFamily({ file: file.path, game: 0 }), deck);
            } else {
                const { positions, added, removed } = syncDeck(
                    existing.positions,
                    tree.root,
                    orientation,
                    start,
                );
                deck = { ...existing, positions };
                if (added > 0 || removed > 0)
                    store.set(deckAtomFamily({ file: file.path, game: 0 }), deck);
            }
            decks[file.path] = deck;
        } catch {
            // Unreadable file: leave it out of the session.
        }
    }
    return dueItems(decks);
}
