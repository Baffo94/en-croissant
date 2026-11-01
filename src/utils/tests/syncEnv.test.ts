import { getDefaultStore } from "jotai";
import { beforeEach, expect, test } from "vitest";
import { deckAtomFamily } from "@/state/atoms";
import { createTauriEnv } from "../sync";

const deck = (fen: string, logs = 0) => ({
    positions: [{ fen, answer: "e4", card: { due: "2026-01-01T00:00:00.000Z", reps: 1 } }],
    logs: Array.from({ length: logs }, (_, i) => ({ fen, review: `2026-10-0${i + 1}T00:00:00Z` })),
});

beforeEach(() => localStorage.clear());

test("reads decks of a file in the sync folder regardless of slashes and case", () => {
    localStorage.setItem(
        "deck-C:\\Docs\\EnCroissant\\Repertori\\White.pgn-0",
        JSON.stringify(deck("A")),
    );
    localStorage.setItem(
        "deck-c:/docs/encroissant/repertori/White.pgn-1",
        JSON.stringify(deck("B")),
    );
    const env = createTauriEnv("C:\\Docs\\EnCroissant\\Repertori");
    const decks = env.getDecks("White.pgn");
    expect(Object.keys(decks).sort()).toEqual(["0", "1"]);
    expect(decks["1"].positions[0].fen).toBe("B");
});

test("imports progress of a repertoire moved into the sync folder", () => {
    localStorage.setItem("deck-C:\\Docs\\EnCroissant\\White.pgn-0", JSON.stringify(deck("A", 2)));
    const env = createTauriEnv("C:\\Docs\\EnCroissant\\Repertori");
    expect(env.getDecks("White.pgn")["0"].logs).toHaveLength(2);
    // copied under the new path, original kept
    expect(
        localStorage.getItem("deck-C:\\Docs\\EnCroissant\\Repertori\\White.pgn-0"),
    ).not.toBeNull();
    expect(localStorage.getItem("deck-C:\\Docs\\EnCroissant\\White.pgn-0")).not.toBeNull();
});

test("does not guess when several files have the same name", () => {
    localStorage.setItem("deck-C:\\A\\White.pgn-0", JSON.stringify(deck("A")));
    localStorage.setItem("deck-C:\\B\\White.pgn-0", JSON.stringify(deck("B")));
    const env = createTauriEnv("C:\\Docs\\Repertori");
    expect(env.getDecks("White.pgn")).toEqual({});
});

test("setDeck writes to the key used by the open tab", () => {
    localStorage.setItem("deck-C:\\Docs\\Repertori\\White.pgn-0", JSON.stringify(deck("A")));
    const env = createTauriEnv("C:\\Docs\\Repertori");
    env.setDeck("White.pgn", "0", deck("Z") as never);
    expect(
        JSON.parse(localStorage.getItem("deck-C:\\Docs\\Repertori\\White.pgn-0")!).positions[0].fen,
    ).toBe("Z");
    expect(
        getDefaultStore().get(deckAtomFamily({ file: "C:\\Docs\\Repertori\\White.pgn", game: 0 }))
            .positions[0].fen,
    ).toBe("Z");
    env.setDeck("New.pgn", "0", deck("N") as never);
    expect(localStorage.getItem("deck-C:\\Docs\\Repertori\\New.pgn-0")).not.toBeNull();
});

test("imports old progress even if the moved file was already opened (fresh deck)", () => {
    localStorage.setItem("deck-C:\\Docs\\White.pgn-0", JSON.stringify(deck("A", 2)));
    const fresh = {
        positions: [{ fen: "A", answer: "e4", card: { due: "2027-01-01T00:00:00.000Z", reps: 0 } }],
        logs: [],
    };
    localStorage.setItem("deck-C:\\Docs\\Repertori\\White.pgn-0", JSON.stringify(fresh));
    const env = createTauriEnv("C:\\Docs\\Repertori");
    const decks = env.getDecks("White.pgn");
    expect(decks["0"].logs).toHaveLength(2);
    expect(decks["0"].positions[0].card.reps).toBe(1);
    const stored = JSON.parse(localStorage.getItem("deck-C:\\Docs\\Repertori\\White.pgn-0")!);
    expect(stored.logs).toHaveLength(2);
});
