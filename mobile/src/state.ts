// App state: settings, a local mirror of the sync repository and the practice decks.
// Kept in memory and persisted as one JSON file in the app's private storage.

import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { useSyncExternalStore } from "react";
import type { PracticeData } from "@/components/files/opening";
import type { ReviewFlag } from "@/utils/flags";
import type { TacticsPack } from "@/utils/training/tactics";
import type { TrainingProgress } from "@/utils/training/trainingDocs";
import type { PauseState } from "@/utils/sync/core";
import type { SyncManifest } from "@/utils/sync/engine";
import { DEFAULT_BOARD, DEFAULT_PIECES } from "./boardThemes";
import { DEFAULT_EXPLORER, type ExplorerSettings } from "./explorer";

export type Config = {
    token: string;
    /** "owner/name" */
    repository: string;
    branch: string;
};

export type CommentEdit = { game: number; line: string[]; text: string };

export type AppState = {
    version: 1;
    config: Config;
    /** Content files of the repository (relative to repertoires/), base64 encoded. */
    files: Record<string, string>;
    /** relPgn -> game index -> deck */
    decks: Record<string, Record<string, PracticeData>>;
    manifest: SyncManifest | null;
    appearance: { board: string; pieces: string };
    explorer: ExplorerSettings;
    /**
     * relPgn -> comments edited on the phone and not yet confirmed on GitHub. Kept
     * until the uploaded PGN contains them, so they can be applied again on top of
     * a version changed meanwhile on the PC.
     */
    commentEdits?: Record<string, CommentEdit[]>;
    /** relPgn -> pause state (synced through the progress files). */
    pauses: Record<string, PauseState>;
    /** relPgn -> moves flagged to review (synced through the progress files). */
    flags?: Record<string, ReviewFlag[]>;
    /** Tactics pack from the PC and progress of tactics and endgames (synced). */
    training?: { pack: TacticsPack | null; progress: TrainingProgress };
};

const FILE = "state.json";
const TMP = "state.tmp.json";

function initialState(): AppState {
    return {
        version: 1,
        config: { token: "", repository: "", branch: "main" },
        files: {},
        decks: {},
        manifest: null,
        appearance: { board: DEFAULT_BOARD, pieces: DEFAULT_PIECES },
        explorer: DEFAULT_EXPLORER,
        pauses: {},
    };
}

let state: AppState = initialState();
let loaded = false;
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> = Promise.resolve();

export async function loadState(): Promise<void> {
    try {
        const { data } = await Filesystem.readFile({
            path: FILE,
            directory: Directory.Data,
            encoding: Encoding.UTF8,
        });
        const parsed = JSON.parse(data as string) as Partial<AppState>;
        state = {
            ...initialState(),
            ...parsed,
            config: { ...initialState().config, ...parsed.config },
            appearance: { ...initialState().appearance, ...parsed.appearance },
            explorer: { ...initialState().explorer, ...parsed.explorer },
            pauses: parsed.pauses ?? {},
        };
    } catch {
        state = initialState();
    }
    loaded = true;
    emit();
}

async function persist() {
    const data = JSON.stringify(state);
    // Write to a temporary file first so a crash never leaves a truncated state.
    await Filesystem.writeFile({
        path: TMP,
        directory: Directory.Data,
        data,
        encoding: Encoding.UTF8,
    });
    const rename = () =>
        Filesystem.rename({
            from: TMP,
            to: FILE,
            directory: Directory.Data,
            toDirectory: Directory.Data,
        });
    try {
        await rename();
    } catch {
        // Some implementations refuse to overwrite: remove the old file and retry.
        await Filesystem.deleteFile({ path: FILE, directory: Directory.Data }).catch(() => {});
        await rename();
    }
}

/** Saves now (waits for pending writes). Call before the app goes to background. */
export function flushState(): Promise<void> {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    saving = saving.then(persist).catch((e) => console.error("save failed", e));
    return saving;
}

function emit() {
    for (const l of listeners) l();
}

export function getState(): AppState {
    return state;
}

export function isLoaded(): boolean {
    return loaded;
}

export function updateState(fn: (s: AppState) => AppState) {
    state = fn(state);
    emit();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        void flushState();
    }, 300);
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useAppState<T>(selector: (s: AppState) => T): T {
    return useSyncExternalStore(subscribe, () => selector(state));
}

export function setDeck(relPgn: string, game: string, deck: PracticeData) {
    updateState((s) => ({
        ...s,
        decks: { ...s.decks, [relPgn]: { ...s.decks[relPgn], [game]: deck } },
    }));
}

// base64 helpers for file contents
export function encodeBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

export function decodeBase64(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

export function fileText(rel: string): string | null {
    const b64 = state.files[rel];
    return b64 === undefined ? null : new TextDecoder().decode(decodeBase64(b64));
}

export function isRepertoirePaused(state: Pick<AppState, "pauses">, rel: string): boolean {
    return state.pauses?.[rel]?.paused === true;
}

/** Pauses or resumes a repertoire (the review schedule is left as it is). */
export function setRepertoirePaused(rel: string, paused: boolean) {
    updateState((s) => ({
        ...s,
        pauses: { ...s.pauses, [rel]: { paused, changedAt: new Date().toISOString() } },
    }));
}
