// The engine's lines on screen only get deeper. When a search starts again on a position
// already analysed (pause and resume, another depth, back to a move seen before), the
// deeper lines stay until the new search catches up with them: Stockfish still has most of
// the previous work in memory, so it gets there quickly.

import type { BestMoves, GoMode } from "@/bindings";

/** Depth of some engine lines (0 for none). */
export function linesDepth(lines: readonly BestMoves[] | undefined): number {
    return lines?.[0]?.depth ?? 0;
}

/**
 * Lines to show when the engine sends `incoming` for a position where `shown` is on
 * screen, or null to leave the screen as it is.
 *
 * The new lines win when they are at least as deep, or when more lines are asked for
 * than are shown; otherwise the deeper ones stay (cut to the number of lines asked for).
 */
export function keepDeeper(
    shown: readonly BestMoves[] | undefined,
    incoming: readonly BestMoves[],
): BestMoves[] | null {
    if (incoming.length === 0) return null;
    if (!shown || shown.length === 0) return [...incoming];
    if (incoming.length > shown.length) return [...incoming];
    if (linesDepth(incoming) >= linesDepth(shown)) return [...incoming];
    return shown.length > incoming.length ? shown.slice(0, incoming.length) : null;
}

/** Progress to show for `lines` with a depth limit: how much of it they already reach. */
export function depthProgress(lines: readonly BestMoves[] | undefined, go: GoMode): number {
    if (go.t !== "Depth" || go.c <= 0) return 0;
    return Math.min(100, (linesDepth(lines) / go.c) * 100);
}

/**
 * The lines on screen already answer the request: as deep as the depth limit, with as
 * many lines as wanted. No need to start the engine.
 */
export function deepEnough(
    shown: readonly BestMoves[] | undefined,
    go: GoMode,
    wanted: number,
): boolean {
    return (
        go.t === "Depth" &&
        !!shown &&
        shown.length >= Math.max(1, wanted) &&
        linesDepth(shown) >= go.c
    );
}

/**
 * Engine options that change the evaluation itself: with other values, earlier lines are
 * not comparable any more. Lines, threads and memory only change speed or count.
 */
export function evaluationSignature(
    options: readonly { name: string; value?: unknown }[] | undefined,
): string {
    const ignored = new Set(["MultiPV", "Threads", "Hash"]);
    return JSON.stringify(
        (options ?? [])
            .filter((o) => !ignored.has(o.name))
            .map((o) => [o.name, String(o.value ?? "")])
            .sort(),
    );
}
