// Training data on the PC (tactics pack built from the analysed games, progress of
// tactics and endgames), kept in localStorage and synced as training/*.json.

import { atom, getDefaultStore } from "jotai";
import type { TacticsPack } from "@/utils/training/tactics";
import type { TrainingStore } from "@/utils/training/syncDocs";
import {
    emptyTrainingProgress,
    parsePack,
    parseTrainingProgress,
    stableJson,
    type TrainingProgress,
} from "@/utils/training/trainingDocs";

const PACK_KEY = "training-tactics-pack";
const PROGRESS_KEY = "training-progress";

function readStorage(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

export const tacticsPackAtom = atom<TacticsPack | null>(parsePack(readStorage(PACK_KEY)));
export const trainingProgressAtom = atom<TrainingProgress>(
    parseTrainingProgress(readStorage(PROGRESS_KEY)),
);

export function setTacticsPack(pack: TacticsPack) {
    localStorage.setItem(PACK_KEY, stableJson(pack));
    getDefaultStore().set(tacticsPackAtom, pack);
}

export function updateTrainingProgress(change: (p: TrainingProgress) => TrainingProgress) {
    const store = getDefaultStore();
    const next = change(store.get(trainingProgressAtom));
    localStorage.setItem(PROGRESS_KEY, stableJson(next));
    store.set(trainingProgressAtom, next);
}

const isEmpty = (p: TrainingProgress) =>
    Object.keys(p.tactics).length === 0 && Object.keys(p.endgames).length === 0;

/** Training files as the sync sees them. */
export const desktopTrainingStore: TrainingStore = {
    readPack: () => {
        const pack = getDefaultStore().get(tacticsPackAtom);
        return pack ? stableJson(pack) : null;
    },
    writePack: (text) => {
        const pack = parsePack(text);
        if (pack) setTacticsPack(pack);
    },
    readProgress: () => {
        const p = getDefaultStore().get(trainingProgressAtom);
        return isEmpty(p) ? null : stableJson(p);
    },
    writeProgress: (text) => updateTrainingProgress(() => parseTrainingProgress(text)),
};

export { emptyTrainingProgress };
