import { createEmptyCard, fsrs, generatorParameters } from "ts-fsrs";
import { expect, test } from "vitest";
import { formatReviewInterval, getNextReviewTimes, reviewClock } from "../opening";

test("the intervals shown do not change within the same minute", () => {
    const f = fsrs(generatorParameters({ enable_fuzz: true }));
    let card = createEmptyCard(new Date("2026-10-01T10:00:00Z"));
    for (const day of [1, 3, 8])
        card = f.repeat(card, new Date(`2026-10-${String(day).padStart(2, "0")}T10:00:00Z`))[3]
            .card;
    const a = reviewClock(new Date("2026-11-14T10:20:05.123Z"));
    const b = reviewClock(new Date("2026-11-14T10:20:47.900Z"));
    expect(getNextReviewTimes(card, a)).toEqual(getNextReviewTimes(card, b));
    const learning = createEmptyCard(a);
    const times = getNextReviewTimes(learning, a);
    expect(formatReviewInterval(times[2], a)).toBe(
        formatReviewInterval(getNextReviewTimes(learning, b)[2], b),
    );
});
