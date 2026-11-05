import type { SetStateAction } from "react";
import {
    type Card,
    createEmptyCard,
    Rating,
    State,
    fsrs,
    type Grade,
    generatorParameters,
    type ReviewLog,
} from "ts-fsrs";
import { z } from "zod";
import { isPrefix } from "@/utils/misc";
import { type TreeNode, treeIterator } from "@/utils/treeReducer";

const params = generatorParameters({ enable_fuzz: true });

const f = fsrs(params);

export const positionSchema = z.object({
    fen: z.string(),
    answer: z.string(),
    card: z.object({}).passthrough(),
});

export type Position = {
    fen: string;
    answer: string;
    card: Card;
};

/** Practice deck of one game: positions to train and the review history. */
export type PracticeData = {
    positions: Position[];
    logs: (ReviewLog & { fen: string })[];
};

export function buildFromTree(tree: TreeNode, color: "white" | "black", start: number[]) {
    const cards: Position[] = [];
    const iterator = treeIterator(tree);
    for (const item of iterator) {
        if (
            item.node.children.length === 0 ||
            isPrefix(item.position, start) ||
            !item.node.children[0].san ||
            cards.find((c) => c.fen === item.node.fen)
        ) {
            continue;
        }
        if (
            (color === "white" && item.node.halfMoves % 2 === 0) ||
            (color === "black" && item.node.halfMoves % 2 === 1)
        ) {
            cards.push({
                fen: item.node.fen,
                answer: item.node.children[0].san,
                card: createEmptyCard(),
            });
        }
    }
    return cards;
}

type Stats = {
    unseen: number;
    due: number;
    practiced: number;
    nextDue: Date | null;
    total: number;
};

/**
 * A position answered wrongly comes back after a few minutes (learning step). Like
 * Anki's "learn ahead limit", it counts as due when that is less than this far
 * away: otherwise a session ends with it pending and it turns up as due a few
 * minutes later on every device, as if the review had not been synced.
 */
export const LEARN_AHEAD_MS = 20 * 60 * 1000;

type Log = PracticeData["logs"][number];

/**
 * Positions whose latest answer was "again". Only these are learned ahead: a
 * position rated "hard" stays in its learning step at every answer, so learning
 * it ahead would bring it back forever.
 */
export function failedFens(logs: readonly Log[]): Set<string> {
    const latest = new Map<string, { time: number; rating: number }>();
    for (const log of logs) {
        const time = new Date(log.review).getTime();
        const prev = latest.get(log.fen);
        if (!prev || time >= prev.time) latest.set(log.fen, { time, rating: log.rating });
    }
    const failed = new Set<string>();
    for (const [fen, { rating }] of latest) if (rating === Rating.Again) failed.add(fen);
    return failed;
}

/** Whether a position is to be reviewed now (`failed`: its latest answer was "again"). */
export function isDue(card: Card, now = new Date(), failed = false): boolean {
    const due = new Date(card.due).getTime();
    if (due <= now.getTime()) return true;
    if (!failed) return false;
    const learning = card.state === State.Learning || card.state === State.Relearning;
    return learning && due - now.getTime() <= LEARN_AHEAD_MS;
}

export function getStats(positions: Position[], logs: readonly Log[] = []) {
    const stats: Stats = {
        unseen: 0,
        due: 0,
        practiced: 0,
        nextDue: null,
        total: positions.length,
    };
    const now = new Date();
    const failed = failedFens(logs);
    for (const card of positions) {
        const dueDate = new Date(card.card.due);
        if (card.card.reps === 0) {
            stats.unseen++;
        } else if (isDue(card.card, now, failed.has(card.fen))) {
            stats.due++;
        } else {
            stats.practiced++;
            if (!stats.nextDue || dueDate < stats.nextDue) {
                stats.nextDue = dueDate;
            }
        }
    }
    return stats;
}

export function getCardForReview(
    positions: Position[],
    options: { random: boolean } = { random: false },
    logs: readonly Log[] = [],
): Position | null {
    if (options.random) {
        return positions[Math.floor(Math.random() * positions.length)];
    }
    const now = new Date();

    const overdue = positions.find((position) => new Date(position.card.due) <= now);
    if (overdue) return overdue;
    // Positions just answered wrongly that are due shortly: earliest first.
    const failed = failedFens(logs);
    const ahead = positions
        .filter((position) => isDue(position.card, now, failed.has(position.fen)))
        .sort((a, b) => new Date(a.card.due).getTime() - new Date(b.card.due).getTime());
    return ahead[0] ?? null;
}

export function updateCardPerformance(
    setPositions: React.Dispatch<SetStateAction<PracticeData>>,
    i: number,
    card: Card,
    grade: 1 | 2 | 3 | 4,
) {
    const schedulingCards = f.repeat(card, new Date());

    const { card: newCard, log } = schedulingCards[grade];

    setPositions((data) => {
        data.positions[i].card = newCard;
        data.logs.push({ ...log, fen: data.positions[i].fen });
        return {
            positions: data.positions,
            logs: data.logs,
        };
    });
}

export function syncDeck(
    existing: Position[],
    tree: TreeNode,
    color: "white" | "black",
    start: number[],
): { positions: Position[]; added: number; removed: number } {
    const freshPositions = buildFromTree(tree, color, start);

    const existingByFen = new Map<string, Position>();
    for (const pos of existing) {
        existingByFen.set(pos.fen, pos);
    }

    let added = 0;
    const merged: Position[] = [];
    for (const pos of freshPositions) {
        const prev = existingByFen.get(pos.fen);
        if (prev) {
            merged.push({ ...prev, answer: pos.answer });
        } else {
            merged.push(pos);
            added++;
        }
    }

    const freshFens = new Set(freshPositions.map((p) => p.fen));
    const removed = existing.filter((p) => !freshFens.has(p.fen)).length;

    return { positions: merged, added, removed };
}

export function getNextReviewTimes(card: Card): Record<Grade, Date> {
    const schedulingCards = f.repeat(card, new Date());
    return {
        1: schedulingCards[1].card.due,
        2: schedulingCards[2].card.due,
        3: schedulingCards[3].card.due,
        4: schedulingCards[4].card.due,
    };
}

export function formatReviewInterval(dueDate: Date): string {
    const now = new Date();
    const diffMs = dueDate.getTime() - now.getTime();
    const diffMin = Math.round(diffMs / 60000);
    const diffHrs = Math.round(diffMs / 3600000);
    const diffDays = Math.round(diffMs / 86400000);

    if (diffMin < 1) return "< 1m";
    if (diffMin < 60) return `${diffMin}m`;
    if (diffHrs < 24) return `${diffHrs}h`;
    if (diffDays < 30) return `${diffDays}d`;
    return `${Math.round(diffDays / 30)}mo`;
}
