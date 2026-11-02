import { beforeEach, expect, test } from "vitest";
import { moveDecks } from "../practiceDecks";

const deck = (fen: string, logs = 1) => ({
    positions: [{ fen, answer: "e4", card: { due: "2026-01-01T00:00:00.000Z", reps: logs } }],
    logs: Array.from({ length: logs }, (_, i) => ({ fen, review: `2026-10-0${i + 1}T00:00:00Z` })),
});
const get = (key: string) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
};

beforeEach(() => localStorage.clear());

test("moves the decks of a renamed file (all games)", () => {
    localStorage.setItem("deck-C:\\Rep\\White.pgn-0", JSON.stringify(deck("A")));
    localStorage.setItem("deck-C:\\Rep\\White.pgn-1", JSON.stringify(deck("B")));
    localStorage.setItem("deck-C:\\Rep\\Other.pgn-0", JSON.stringify(deck("C")));
    expect(moveDecks("C:\\Rep\\White.pgn", "C:\\Rep\\Bianco.pgn")).toBe(2);
    expect(get("deck-C:\\Rep\\White.pgn-0")).toBeNull();
    expect(get("deck-C:\\Rep\\Bianco.pgn-0").positions[0].fen).toBe("A");
    expect(get("deck-C:\\Rep\\Bianco.pgn-1").positions[0].fen).toBe("B");
    expect(get("deck-C:\\Rep\\Other.pgn-0").positions[0].fen).toBe("C");
});

test("moves every deck inside a moved folder", () => {
    localStorage.setItem("deck-C:\\Rep\\Old\\A.pgn-0", JSON.stringify(deck("A")));
    localStorage.setItem("deck-C:\\Rep\\Old\\sub\\B.pgn-0", JSON.stringify(deck("B")));
    localStorage.setItem("deck-C:\\Rep\\Older\\C.pgn-0", JSON.stringify(deck("C")));
    expect(moveDecks("C:\\Rep\\Old", "C:\\Rep\\New\\Old")).toBe(2);
    expect(get("deck-C:\\Rep\\New\\Old\\A.pgn-0").positions[0].fen).toBe("A");
    expect(get("deck-C:\\Rep\\New\\Old\\sub\\B.pgn-0").positions[0].fen).toBe("B");
    expect(get("deck-C:\\Rep\\Older\\C.pgn-0")).not.toBeNull();
});

test("merges into a deck already at the destination", () => {
    localStorage.setItem("deck-C:\\Rep\\White.pgn-0", JSON.stringify(deck("A", 2)));
    localStorage.setItem("deck-C:\\Rep\\Bianco.pgn-0", JSON.stringify({ ...deck("A", 0) }));
    moveDecks("C:\\Rep\\White.pgn", "C:\\Rep\\Bianco.pgn");
    const merged = get("deck-C:\\Rep\\Bianco.pgn-0");
    expect(merged.logs).toHaveLength(2);
    expect(merged.positions[0].card.reps).toBe(2);
});

test("pause state: set, follows renames and folder moves, removed with the decks", async () => {
    const { getPause, isRepertoirePaused, setPaused, removeDecks } =
        await import("../practiceDecks");
    setPaused("C:\\Rep\\Old\\Scotch.pgn", true);
    expect(isRepertoirePaused("c:/rep/old/scotch.pgn")).toBe(true);
    moveDecks("C:\\Rep\\Old\\Scotch.pgn", "C:\\Rep\\Old\\Scozzese.pgn");
    expect(isRepertoirePaused("C:\\Rep\\Old\\Scotch.pgn")).toBe(false);
    expect(isRepertoirePaused("C:\\Rep\\Old\\Scozzese.pgn")).toBe(true);
    moveDecks("C:\\Rep\\Old", "C:\\Rep\\New");
    expect(isRepertoirePaused("C:\\Rep\\New\\Scozzese.pgn")).toBe(true);
    removeDecks("C:\\Rep\\New\\Scozzese.pgn");
    expect(getPause("C:\\Rep\\New\\Scozzese.pgn")).toBeNull();
});
