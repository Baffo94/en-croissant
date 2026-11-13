// The training files kept in the repository next to the repertoires:
// - training/tactics.json: the tactics from your games, built by the PC (the phone only
//   reads it);
// - training/progress.json: the progress of tactics and endgames, merged per exercise
//   between the devices.

import { canonical } from "@/utils/sync/core";
import { mergeProgress, type ProgressMap } from "./srs";
import type { TacticsPack } from "./tactics";

export type TrainingProgress = {
    version: 1;
    tactics: ProgressMap;
    endgames: ProgressMap;
};

export function emptyTrainingProgress(): TrainingProgress {
    return { version: 1, tactics: {}, endgames: {} };
}

/** Stable text, so identical content always has the same blob sha. */
export function stableJson(value: unknown): string {
    return `${JSON.stringify(canonical(value), null, 1)}\n`;
}

export function parseTrainingProgress(text: string | null): TrainingProgress {
    if (!text) return emptyTrainingProgress();
    try {
        const parsed = JSON.parse(text) as Partial<TrainingProgress>;
        return {
            version: 1,
            tactics: parsed.tactics && typeof parsed.tactics === "object" ? parsed.tactics : {},
            endgames: parsed.endgames && typeof parsed.endgames === "object" ? parsed.endgames : {},
        };
    } catch {
        return emptyTrainingProgress();
    }
}

export function mergeTrainingProgress(
    local: TrainingProgress,
    remote: TrainingProgress,
): TrainingProgress {
    return {
        version: 1,
        tactics: mergeProgress(local.tactics, remote.tactics),
        endgames: mergeProgress(local.endgames, remote.endgames),
    };
}

/** Merge for the sync: texts in, text out (null when there is nothing on either side). */
export function mergeTrainingProgressText(
    local: string | null,
    remote: string | null,
): string | null {
    if (!local && !remote) return null;
    if (!remote) return local;
    const merged = mergeTrainingProgress(
        parseTrainingProgress(local),
        parseTrainingProgress(remote),
    );
    return stableJson(merged);
}

export function parsePack(text: string | null): TacticsPack | null {
    if (!text) return null;
    try {
        const pack = JSON.parse(text) as TacticsPack;
        return pack && Array.isArray(pack.tactics) ? pack : null;
    } catch {
        return null;
    }
}
