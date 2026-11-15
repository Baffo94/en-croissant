import { createEmptyCard } from "ts-fsrs";
import { expect, test } from "vitest";
import { syncDeck } from "@/components/files/opening";
import { describeOp, type EditEntry, mergeHistory, mergeHistoryText } from "../editHistory";
import { readGame } from "../repertoireEdit";

const entry = (id: string, at: string, undoneAt?: string): EditEntry => ({
    id,
    at,
    device: "phone",
    rel: "Philidor.pgn",
    game: 0,
    op: { kind: "add", line: ["e4"] },
    inverse: { kind: "delete", line: ["e4"] },
    summary: "x",
    undoneAt,
});

test("history: union by id, undone on either side stays undone", () => {
    const a = {
        version: 1 as const,
        entries: [entry("1", "2026-11-14T10:00:00Z"), entry("2", "2026-11-14T11:00:00Z")],
    };
    const b = {
        version: 1 as const,
        entries: [
            entry("2", "2026-11-14T11:00:00Z", "2026-11-14T12:00:00Z"),
            entry("3", "2026-11-14T09:00:00Z"),
        ],
    };
    const merged = mergeHistory(a, b);
    expect(merged.entries.map((e) => e.id)).toEqual(["3", "1", "2"]);
    expect(merged.entries[2].undoneAt).toBe("2026-11-14T12:00:00Z");
    expect(mergeHistory(b, a)).toEqual(merged);
    expect(mergeHistoryText(null, null)).toBeNull();
    expect(mergeHistoryText("x", null)).toBe("x");
});

test("words for an edit", () => {
    expect(describeOp({ kind: "add", line: ["e4", "e5", "Qh5"] })).toBe(
        "Aggiunta 2.Qh5 dopo 1...e5",
    );
    expect(describeOp({ kind: "delete", line: ["e4"] }, 0, { moves: 5 })).toBe(
        "Eliminata 1.e4 (e le 4 mosse seguenti)",
    );
    expect(describeOp({ kind: "promote", line: ["d4"] })).toBe("1.d4 diventa la mossa principale");
});

test("a position whose move changed is learnt again; the others keep their progress", () => {
    const before = readGame("1. e4 e5 2. Nf3 (2. Bc4) Nc6 3. d4 *", 0)!.root;
    const after = readGame("1. e4 e5 2. Bc4 (2. Nf3 Nc6 3. d4) *", 0)!.root;
    const reviewed = { ...createEmptyCard(new Date("2026-11-01")), reps: 4 };
    const old = syncDeck([], before, "white", []).positions.map((p) => ({ ...p, card: reviewed }));
    expect(old.map((p) => p.answer)).toEqual(["Nf3", "d4"]);
    const { positions, added } = syncDeck(old, after, "white", []);
    expect(positions.map((p) => [p.answer, p.card.reps])).toEqual([
        ["Bc4", 0],
        ["d4", 4],
    ]);
    expect(added).toBe(1);
});

test("your other saved moves are accepted too", async () => {
    const { isAcceptedMove } = await import("@/components/files/opening");
    const root = readGame("1. e4 e5 2. Nf3 (2. Bc4) (2. Nc3) Nc6 *", 0)!.root;
    const [pos] = syncDeck([], root, "white", []).positions;
    expect(pos.answer).toBe("Nf3");
    expect(pos.alternatives).toEqual(["Bc4", "Nc3"]);
    expect(isAcceptedMove(pos, "Bc4")).toBe(true);
    expect(isAcceptedMove(pos, "d4")).toBe(false);
    // An alternative deleted from the file is no longer accepted.
    const after = readGame("1. e4 e5 2. Nf3 Nc6 *", 0)!.root;
    const [again] = syncDeck([pos], after, "white", []).positions;
    expect(again.alternatives).toBeUndefined();
});
