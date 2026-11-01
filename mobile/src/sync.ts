// Mobile side of the GitHub sync: same engine as the desktop app, but repertoires are
// read-only here (only practice progress is uploaded).

import { useSyncExternalStore } from "react";
import type { PracticeData } from "@/components/files/opening";
import {
    emptyManifest,
    ConcurrentPushError,
    runSync,
    type SyncEnv,
    type SyncSummary,
} from "@/utils/sync/engine";
import { GitHubClient } from "@/utils/sync/github";
import { decodeBase64, encodeBase64, getState, updateState, type Config } from "./state";

export function parseRepository(value: string): { owner: string; repo: string } | null {
    const cleaned = value
        .trim()
        .replace(/^https?:\/\/github\.com\//i, "")
        .replace(/\.git$/i, "")
        .replace(/\/+$/, "");
    const match = /^([\w.-]+)\/([\w.-]+)$/.exec(cleaned);
    return match ? { owner: match[1], repo: match[2] } : null;
}

export function isConfigured(config: Config): boolean {
    return config.token.trim() !== "" && parseRepository(config.repository) !== null;
}

export function createClient(config: Config): GitHubClient {
    const parsed = parseRepository(config.repository);
    if (!parsed) throw new Error("Repository non valido (formato: proprietario/nome)");
    return new GitHubClient(
        config.token.trim(),
        { ...parsed, branch: config.branch.trim() || "main" },
        (url, init) => fetch(url, init),
    );
}

const memoryEnv: SyncEnv = {
    async listLocalFiles() {
        return Object.keys(getState().files);
    },
    async readFile(rel) {
        return decodeBase64(getState().files[rel]);
    },
    async writeFile(rel, content) {
        updateState((s) => ({ ...s, files: { ...s.files, [rel]: encodeBase64(content) } }));
    },
    async removeFile(rel) {
        updateState((s) => {
            const files = { ...s.files };
            delete files[rel];
            const decks = { ...s.decks };
            delete decks[rel];
            return { ...s, files, decks };
        });
    },
    getDecks(rel) {
        return structuredClone(getState().decks[rel] ?? {}) as Record<string, PracticeData>;
    },
    setDeck(rel, game, deck) {
        updateState((s) => ({
            ...s,
            decks: { ...s.decks, [rel]: { ...s.decks[rel], [game]: deck } },
        }));
    },
};

// ---------------------------------------------------------------------------
// Status + scheduler
// ---------------------------------------------------------------------------

export type SyncStatus = {
    state: "idle" | "syncing" | "success" | "error";
    message?: string;
    summary?: SyncSummary;
};

let status: SyncStatus = { state: "idle" };
const listeners = new Set<() => void>();

function setStatus(next: SyncStatus) {
    status = next;
    for (const l of listeners) l();
}

export function useSyncStatus(): SyncStatus {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => status,
    );
}

let running: Promise<SyncSummary | null> | null = null;
let rerun = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function doSync(): Promise<SyncSummary | null> {
    const { config } = getState();
    if (!isConfigured(config)) return null;
    setStatus({ ...status, state: "syncing", message: undefined });
    try {
        const parsed = parseRepository(config.repository)!;
        const key = `${parsed.owner}/${parsed.repo}#${config.branch.trim() || "main"}|mobile`;
        const client = createClient(config);
        for (let attempt = 0; ; attempt++) {
            const previous = getState().manifest;
            const manifest = previous && previous.key === key ? previous : emptyManifest(key);
            try {
                const result = await runSync(memoryEnv, client, manifest, {
                    deviceName: "Android",
                    readOnlyContent: true,
                });
                updateState((s) => ({ ...s, manifest: result.manifest }));
                setStatus({ state: "success", summary: result.summary });
                return result.summary;
            } catch (e) {
                if (!(e instanceof ConcurrentPushError) || attempt >= 2) throw e;
            }
        }
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setStatus({ ...status, state: "error", message });
        throw e;
    }
}

/** Runs a sync now (or right after the one in progress). */
export function syncNow(): Promise<SyncSummary | null> {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    if (running) {
        rerun = true;
        return running;
    }
    running = (async () => {
        try {
            let summary = await doSync();
            while (rerun) {
                rerun = false;
                summary = await doSync();
            }
            return summary;
        } finally {
            running = null;
        }
    })();
    return running;
}

/** Sync after `delayMs` of quiet; repeated calls postpone it. Errors only update the status. */
export function scheduleSync(delayMs: number) {
    if (!isConfigured(getState().config)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
        timer = null;
        syncNow().catch(() => {});
    }, delayMs);
}
