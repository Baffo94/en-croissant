// Spaced repetition for training exercises (tactics from your games, theoretical
// endgames): one FSRS card per exercise, plus a short history of attempts. Shared by
// the desktop app and the phone, and merged between them by the sync.

import { type Card, createEmptyCard, fsrs, generatorParameters, Rating } from "ts-fsrs";
import { newerCard } from "@/utils/sync/core";

const f = fsrs(generatorParameters({ enable_fuzz: true }));

export type Attempt = { at: string; ok: boolean };

export type ExerciseProgress = {
    card: Card;
    /** Last attempts, oldest first (at most HISTORY). */
    history: Attempt[];
};

/** Progress of a family of exercises: exercise id -> progress. */
export type ProgressMap = Record<string, ExerciseProgress>;

const HISTORY = 30;

export type Outcome = "again" | "hard" | "good" | "easy";

const RATING: Record<Outcome, Rating.Again | Rating.Hard | Rating.Good | Rating.Easy> = {
    again: Rating.Again,
    hard: Rating.Hard,
    good: Rating.Good,
    easy: Rating.Easy,
};

function asDate(d: Date | string | undefined | null): Date | undefined {
    if (!d) return undefined;
    return d instanceof Date ? d : new Date(d);
}

/** Cards come back from JSON with dates as strings. */
export function reviveCard(card: Card): Card {
    return {
        ...card,
        due: asDate(card.due) as Date,
        last_review: asDate(card.last_review),
    };
}

export function reviewExercise(
    current: ExerciseProgress | undefined,
    outcome: Outcome,
    now: Date = new Date(),
): ExerciseProgress {
    const card = current ? reviveCard(current.card) : createEmptyCard(now);
    const next = f.repeat(card, now)[RATING[outcome]].card;
    const history = [
        ...(current?.history ?? []),
        { at: now.toISOString(), ok: outcome !== "again" },
    ];
    return { card: next, history: history.slice(-HISTORY) };
}

export function isNew(p: ExerciseProgress | undefined): boolean {
    return !p || (p.card.reps ?? 0) === 0;
}

export function isDue(p: ExerciseProgress | undefined, now: Date = new Date()): boolean {
    if (!p || isNew(p)) return false;
    return new Date(p.card.due).getTime() <= now.getTime();
}

/** Exercises tried for the first time on the given day (local time). */
export function newToday(progress: ProgressMap, now: Date = new Date()): number {
    const day = now.toDateString();
    return Object.values(progress).filter(
        (p) => p.history.length > 0 && new Date(p.history[0].at).toDateString() === day,
    ).length;
}

export type SessionPlan = {
    /** Due exercises (most overdue first), then new ones (in the given order). */
    ids: string[];
    due: number;
    fresh: number;
};

/**
 * The exercises of a session: everything due, then up to `newPerDay` new ones (minus the
 * new ones already started today).
 */
export function planSession(
    ids: readonly string[],
    progress: ProgressMap,
    newPerDay: number,
    now: Date = new Date(),
): SessionPlan {
    const due = ids
        .filter((id) => isDue(progress[id], now))
        .sort(
            (a, b) =>
                new Date(progress[a].card.due).getTime() - new Date(progress[b].card.due).getTime(),
        );
    const room = Math.max(0, newPerDay - newToday(progress, now));
    const fresh = ids.filter((id) => isNew(progress[id])).slice(0, room);
    return { ids: [...due, ...fresh], due: due.length, fresh: fresh.length };
}

export type ProgressStats = {
    total: number;
    seen: number;
    due: number;
    /** Share of first-try successes over the last attempts (null without attempts). */
    successRate: number | null;
};

export function progressStats(
    ids: readonly string[],
    progress: ProgressMap,
    now: Date = new Date(),
): ProgressStats {
    let seen = 0;
    let due = 0;
    let ok = 0;
    let attempts = 0;
    for (const id of ids) {
        const p = progress[id];
        if (!p || isNew(p)) continue;
        seen++;
        if (isDue(p, now)) due++;
        for (const a of p.history.slice(-5)) {
            attempts++;
            if (a.ok) ok++;
        }
    }
    return { total: ids.length, seen, due, successRate: attempts ? ok / attempts : null };
}

/** Per exercise, the card reviewed last wins; histories are joined without duplicates. */
export function mergeProgress(local: ProgressMap, remote: ProgressMap): ProgressMap {
    const out: ProgressMap = {};
    for (const id of new Set([...Object.keys(local), ...Object.keys(remote)])) {
        const a = local[id];
        const b = remote[id];
        if (!a || !b) {
            out[id] = (a ?? b) as ExerciseProgress;
            continue;
        }
        const card = newerCard(a.card, b.card) as Card;
        const seen = new Set<string>();
        const history = [...a.history, ...b.history]
            .filter((h) => {
                const key = `${h.at}|${h.ok}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .sort((x, y) => x.at.localeCompare(y.at))
            .slice(-HISTORY);
        out[id] = { card, history };
    }
    return out;
}
