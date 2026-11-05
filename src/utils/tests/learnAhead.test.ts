import { createEmptyCard, fsrs, generatorParameters, Rating, State } from "ts-fsrs";
import { describe, expect, test } from "vitest";
import {
    failedFens,
    getCardForReview,
    getStats,
    isDue,
    type PracticeData,
} from "@/components/files/opening";

const now = new Date();
const inMinutes = (m: number) => new Date(now.getTime() + m * 60_000);
const card = (state: State, due: Date) => ({ ...createEmptyCard(now), state, due, reps: 2 });
const log = (fen: string, rating: Rating, minutesAgo: number) =>
    ({ fen, rating, review: inMinutes(-minutesAgo) }) as unknown as PracticeData["logs"][number];

describe("learn ahead", () => {
    test("only positions just answered wrongly are learned ahead", () => {
        expect(isDue(card(State.Relearning, inMinutes(5)), now, true)).toBe(true);
        expect(isDue(card(State.Learning, inMinutes(10)), now, true)).toBe(true);
        expect(isDue(card(State.Relearning, inMinutes(25)), now, true)).toBe(false);
        expect(isDue(card(State.Relearning, inMinutes(5)), now, false)).toBe(false);
        expect(isDue(card(State.Review, inMinutes(5)), now, true)).toBe(false);
        expect(isDue(card(State.Review, inMinutes(-1)), now, false)).toBe(true);
    });

    test("failedFens uses the latest answer of each position", () => {
        const logs = [
            log("a", Rating.Again, 3),
            log("a", Rating.Hard, 1),
            log("b", Rating.Again, 1),
        ];
        expect([...failedFens(logs)]).toEqual(["b"]);
    });

    test("overdue positions come first, then the ones answered wrongly", () => {
        const positions = [
            { fen: "a", answer: "e4", card: card(State.Relearning, inMinutes(5)) },
            { fen: "b", answer: "d4", card: card(State.Review, inMinutes(-60)) },
        ];
        const logs = [log("a", Rating.Again, 1)];
        expect(getCardForReview(positions, undefined, logs)?.fen).toBe("b");
        expect(getStats(positions, logs).due).toBe(2);
        expect(getStats(positions).due).toBe(1);
    });

    test("a session ends whatever the rating after a correct answer", () => {
        const f = fsrs(generatorParameters({ enable_fuzz: true }));
        for (const grade of [Rating.Hard, Rating.Good, Rating.Easy] as const) {
            let c = f.repeat(createEmptyCard(now), now)[Rating.Again].card;
            const logs = [log("x", Rating.Again, 0)];
            let shown = 0;
            while (getCardForReview([{ fen: "x", answer: "e4", card: c }], undefined, logs)) {
                if (++shown > 5) break;
                const { card: next, log: l } = f.repeat(c, now)[grade];
                c = next;
                logs.push({ ...l, fen: "x" });
            }
            expect(shown).toBe(1);
        }
    });
});
