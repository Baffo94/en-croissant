import { describe, expect, test } from "vitest";
import { isDue, mergeProgress, newToday, planSession, progressStats, reviewExercise } from "../srs";

const at = (iso: string) => new Date(iso);

describe("exercise repetition", () => {
    test("a failed exercise comes back soon, a solved one later", () => {
        const now = at("2026-11-13T10:00:00Z");
        const failed = reviewExercise(undefined, "again", now);
        const solved = reviewExercise(undefined, "good", now);
        expect(new Date(failed.card.due).getTime()).toBeLessThan(
            new Date(solved.card.due).getTime(),
        );
        expect(failed.history).toEqual([{ at: now.toISOString(), ok: false }]);
        expect(isDue(solved, at("2026-11-13T10:01:00Z"))).toBe(false);
        expect(isDue(solved, at("2026-12-30T10:00:00Z"))).toBe(true);
        // Cards survive a JSON round trip.
        const again = reviewExercise(
            JSON.parse(JSON.stringify(solved)),
            "good",
            at("2026-11-20T10:00:00Z"),
        );
        expect(again.history).toHaveLength(2);
        expect(again.card.reps).toBe(2);
    });

    test("sessions: due first, then new ones within the daily limit", () => {
        const now = at("2026-11-13T10:00:00Z");
        const progress = {
            a: reviewExercise(undefined, "good", at("2026-10-01T10:00:00Z")),
            b: reviewExercise(undefined, "again", at("2026-11-13T09:00:00Z")),
        };
        expect(newToday(progress, now)).toBe(1);
        const plan = planSession(["a", "b", "c", "d", "e"], progress, 3, now);
        expect(plan.ids.slice(0, plan.due).sort()).toEqual(["a", "b"]);
        expect(plan.ids.slice(plan.due)).toEqual(["c", "d"]);
        expect(progressStats(["a", "b", "c"], progress, now)).toMatchObject({
            total: 3,
            seen: 2,
            due: 2,
        });
    });

    test("merge: the card reviewed last wins, histories are joined", () => {
        const base = reviewExercise(undefined, "good", at("2026-11-01T10:00:00Z"));
        const phone = reviewExercise(base, "again", at("2026-11-05T10:00:00Z"));
        const pc = reviewExercise(base, "good", at("2026-11-03T10:00:00Z"));
        const merged = mergeProgress({ x: pc }, { x: phone, y: base });
        expect(merged.x.card.last_review).toEqual(phone.card.last_review);
        expect(merged.x.history.map((h) => h.ok)).toEqual([true, true, false]);
        expect(merged.y).toBe(base);
    });
});
