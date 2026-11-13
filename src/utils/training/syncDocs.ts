// The training files as synced documents (see SyncDoc in the sync engine).

import type { SyncDoc } from "@/utils/sync/engine";
import { TACTICS_PACK_PATH, TRAINING_PROGRESS_PATH } from "./tactics";
import { mergeTrainingProgressText } from "./trainingDocs";

export type TrainingStore = {
    readPack(): string | null;
    writePack(text: string): void;
    readProgress(): string | null;
    writeProgress(text: string): void;
};

/**
 * The PC writes the tactics pack (built from its analysed games) and the phone only reads
 * it; the progress is merged per exercise by both.
 */
export function trainingDocs(store: TrainingStore, role: "pc" | "phone"): SyncDoc[] {
    return [
        {
            path: TACTICS_PACK_PATH,
            read: store.readPack,
            write: store.writePack,
            merge:
                role === "pc"
                    ? (local, remote) => local ?? remote
                    : (local, remote) => remote ?? local,
            upload: role === "pc",
        },
        {
            path: TRAINING_PROGRESS_PATH,
            read: store.readProgress,
            write: store.writeProgress,
            merge: mergeTrainingProgressText,
            upload: true,
        },
    ];
}
