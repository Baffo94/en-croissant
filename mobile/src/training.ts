// Training on the phone: the tactics pack prepared by the PC and the progress of tactics
// and endgames, kept in the app state and synced as training/*.json.

import { type Outcome, reviewExercise } from "@/utils/training/srs";
import type { TrainingStore } from "@/utils/training/syncDocs";
import {
    emptyTrainingProgress,
    parsePack,
    parseTrainingProgress,
    stableJson,
    type TrainingProgress,
} from "@/utils/training/trainingDocs";
import { getState, updateState, useAppState } from "./state";

const isEmpty = (p: TrainingProgress) =>
    Object.keys(p.tactics).length === 0 && Object.keys(p.endgames).length === 0;

export const phoneTrainingStore: TrainingStore = {
    readPack: () => {
        const pack = getState().training?.pack;
        return pack ? stableJson(pack) : null;
    },
    writePack: (text) => {
        const pack = parsePack(text);
        if (!pack) return;
        updateState((s) => ({
            ...s,
            training: { pack, progress: s.training?.progress ?? emptyTrainingProgress() },
        }));
    },
    readProgress: () => {
        const p = getState().training?.progress;
        return p && !isEmpty(p) ? stableJson(p) : null;
    },
    writeProgress: (text) => {
        const progress = parseTrainingProgress(text);
        updateState((s) => ({ ...s, training: { pack: s.training?.pack ?? null, progress } }));
    },
};

export function useTraining() {
    return useAppState((s) => s.training);
}

/** Records the result of an exercise. */
export function recordExercise(family: "tactics" | "endgames", id: string, outcome: Outcome) {
    updateState((s) => {
        const progress = s.training?.progress ?? emptyTrainingProgress();
        const next: TrainingProgress = {
            ...progress,
            [family]: { ...progress[family], [id]: reviewExercise(progress[family][id], outcome) },
        };
        return { ...s, training: { pack: s.training?.pack ?? null, progress: next } };
    });
}
