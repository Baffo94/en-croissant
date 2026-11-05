import { createEmptyCard, State } from "ts-fsrs";
import { describe, expect, test } from "vitest";
import { getCardForReview, getStats, isDue } from "@/components/files/opening";

const now = new Date();
const inMinutes = (m: number) => new Date(now.getTime() + m * 60_000);
const card = (state: State, due: Date) => ({ ...createEmptyCard(now), state, due, reps: 2 });

describe("learn ahead", () => {
    test("learning steps due within 20 minutes count as due", () => {
        expect(isDue(card(State.Relearning, inMinutes(5)), now)).toBe(true);
        expect(isDue(card(State.Learning, inMinutes(10)), now)).toBe(true);
        expect(isDue(card(State.Relearning, inMinutes(25)), now)).toBe(false);
    });

    test("review cards only when actually due", () => {
        expect(isDue(card(State.Review, inMinutes(5)), now)).toBe(false);
        expect(isDue(card(State.Review, inMinutes(-1)), now)).toBe(true);
    });

    test("overdue cards come before learning steps", () => {
        const positions = [
            { fen: "a", answer: "e4", card: card(State.Relearning, inMinutes(5)) },
            { fen: "b", answer: "d4", card: card(State.Review, inMinutes(-60)) },
        ];
        expect(getCardForReview(positions)?.fen).toBe("b");
        expect(getStats(positions).due).toBe(2);
    });
});
