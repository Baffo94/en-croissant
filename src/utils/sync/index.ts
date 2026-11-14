// Desktop glue for the GitHub sync: settings, status, the Tauri filesystem/localStorage
// environment and a small scheduler so that automatic syncs never overlap.

import { fetch } from "@tauri-apps/plugin-http";
import { mkdir, readDir, readFile, remove, writeFile, exists } from "@tauri-apps/plugin-fs";
import { hostname } from "@tauri-apps/plugin-os";
import { info as logInfo, warn as logWarn } from "@tauri-apps/plugin-log";
import { atom, getDefaultStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { deckAtomFamily, type PracticeData } from "@/state/atoms";
import { getDocumentDir } from "@/utils/directories";
import { desktopHistoryStore } from "@/state/editHistory";
import { desktopTrainingStore } from "@/state/training";
import { editHistoryDoc } from "@/utils/editHistory";
import { getFlags, getPause, moveDecks, setFlags, setPauseState } from "@/utils/practiceDecks";
import { trainingDocs } from "@/utils/training/syncDocs";
import {
    baseName,
    emptyDeck,
    isContentPath,
    mergeDecks,
    normalizePath,
    parseDeckKey,
    relativePath,
} from "./core";
import {
    retryConcurrent,
    emptyManifest,
    runSync,
    type SyncEnv,
    type SyncManifest,
    type SyncSummary,
} from "./engine";
import { GitHubClient, type FetchLike } from "./github";
import { reloadTabs, tabsOfFiles } from "@/utils/reloadTabs";
import { notifications } from "@mantine/notifications";
import i18n from "i18next";

// Logging must never break a sync (e.g. outside Tauri).
const info = (msg: string) => void logInfo(msg).catch(() => {});
const warn = (msg: string) => void logWarn(msg).catch(() => {});

export type SyncConfig = {
    token: string;
    /** "owner/name" */
    repository: string;
    branch: string;
    /** Local folder to sync; empty means <documents>/EnCroissant/Repertori */
    folder: string;
    auto: boolean;
};

export const DEFAULT_SYNC_FOLDER_NAME = "Repertori";

export const syncConfigAtom = atomWithStorage<SyncConfig>(
    "sync-config",
    { token: "", repository: "", branch: "main", folder: "", auto: true },
    undefined,
    { getOnInit: true },
);

export type SyncStatus = {
    state: "idle" | "syncing" | "success" | "error";
    message?: string;
    lastSync?: string | null;
    summary?: SyncSummary;
};

const MANIFEST_KEY = "sync-manifest";

function loadManifest(): SyncManifest | null {
    try {
        const raw = localStorage.getItem(MANIFEST_KEY);
        return raw ? (JSON.parse(raw) as SyncManifest) : null;
    } catch {
        return null;
    }
}

function saveManifest(manifest: SyncManifest) {
    localStorage.setItem(MANIFEST_KEY, JSON.stringify(manifest));
}

export const syncStatusAtom = atom<SyncStatus>({
    state: "idle",
    lastSync: loadManifest()?.lastSync ?? null,
});

export function parseRepository(value: string): { owner: string; repo: string } | null {
    const cleaned = value
        .trim()
        .replace(/^https?:\/\/github\.com\//i, "")
        .replace(/\.git$/i, "")
        .replace(/\/+$/, "");
    const match = /^([\w.-]+)\/([\w.-]+)$/.exec(cleaned);
    return match ? { owner: match[1], repo: match[2] } : null;
}

export function isConfigured(config: SyncConfig): boolean {
    return config.token.trim() !== "" && parseRepository(config.repository) !== null;
}

export async function resolveSyncFolder(config: SyncConfig): Promise<string> {
    if (config.folder.trim()) return config.folder.trim();
    const documents = await getDocumentDir();
    const sep = documents.includes("\\") ? "\\" : "/";
    return `${documents.replace(/[\\/]+$/, "")}${sep}${DEFAULT_SYNC_FOLDER_NAME}`;
}

export function createClient(config: SyncConfig): GitHubClient {
    const parsed = parseRepository(config.repository);
    if (!parsed) throw new Error("Invalid repository (expected owner/name)");
    return new GitHubClient(
        config.token.trim(),
        { ...parsed, branch: config.branch.trim() || "main" },
        fetch as unknown as FetchLike,
    );
}

// ---------------------------------------------------------------------------
// Tauri environment
// ---------------------------------------------------------------------------

function readDeckFromStorage(key: string): PracticeData | null {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as PracticeData;
        if (!Array.isArray(parsed?.positions) || !Array.isArray(parsed?.logs)) return null;
        return parsed;
    } catch {
        return null;
    }
}

function allDeckKeys(): { key: string; file: string; game: number }[] {
    const keys: { key: string; file: string; game: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        const parsed = parseDeckKey(key);
        if (parsed) keys.push({ key, ...parsed });
    }
    return keys;
}

export function createTauriEnv(folder: string): SyncEnv {
    const sep = folder.includes("\\") ? "\\" : "/";
    const root = folder.replace(/[\\/]+$/, "");
    const abs = (rel: string) => `${root}${sep}${rel.split("/").join(sep)}`;
    const parentOf = (path: string) =>
        path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));

    /** Exact file strings used as deck keys for this PGN (paths may differ in slashes/case). */
    const deckFilesFor = (relPgn: string): string[] => {
        const target = normalizePath(abs(relPgn));
        return [
            ...new Set(
                allDeckKeys()
                    .filter((k) => normalizePath(k.file) === target)
                    .map((k) => k.file),
            ),
        ];
    };

    return {
        async listLocalFiles() {
            if (!(await exists(root))) await mkdir(root, { recursive: true });
            const result: string[] = [];
            const walk = async (dir: string, prefix: string) => {
                for (const entry of await readDir(dir)) {
                    if (entry.name.startsWith(".")) continue;
                    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
                    if (entry.isDirectory) await walk(`${dir}${sep}${entry.name}`, rel);
                    else if (entry.isFile && isContentPath(entry.name)) result.push(rel);
                }
            };
            await walk(root, "");
            return result;
        },
        readFile: (rel) => readFile(abs(rel)),
        async writeFile(rel, content) {
            const path = abs(rel);
            const parent = parentOf(path);
            if (parent && !(await exists(parent))) await mkdir(parent, { recursive: true });
            await writeFile(path, content);
        },
        removeFile: (rel) => remove(abs(rel)),
        getDecks(relPgn) {
            const target = normalizePath(abs(relPgn));
            const keys = allDeckKeys();

            const readDecks = (list: typeof keys) => {
                const decks: Record<string, PracticeData> = {};
                for (const k of list) {
                    const deck = readDeckFromStorage(k.key);
                    if (!deck) continue;
                    const game = String(k.game);
                    // Several spellings of the same path: keep the richest deck.
                    if (!decks[game] || deck.logs.length > decks[game].logs.length)
                        decks[game] = deck;
                }
                return decks;
            };

            const decks = readDecks(keys.filter((k) => normalizePath(k.file) === target));

            // Recover the progress of a repertoire that was moved into the sync folder:
            // only if this path has no review history yet, and exactly one file with the
            // same name outside the folder has some. Old keys are left untouched.
            const hasHistory = Object.values(decks).some((d) => d.logs.length > 0);
            if (!hasHistory) {
                const name = baseName(relPgn);
                const candidates = keys.filter(
                    (k) => baseName(k.file) === name && relativePath(root, k.file) === null,
                );
                const old = readDecks(candidates);
                const files = new Set(candidates.map((k) => k.file));
                if (files.size === 1 && Object.values(old).some((d) => d.logs.length > 0)) {
                    info(
                        `sync: importing practice progress of ${[...files][0]} into ${abs(relPgn)}`,
                    );
                    const store = getDefaultStore();
                    for (const [game, deck] of Object.entries(old)) {
                        decks[game] = mergeDecks(decks[game] ?? emptyDeck(), deck);
                        for (const file of deckFilesFor(relPgn).concat(abs(relPgn))) {
                            store.set(deckAtomFamily({ file, game: Number(game) }), decks[game]);
                        }
                    }
                }
            }
            return decks;
        },
        getPause: (relPgn) => getPause(abs(relPgn)),
        getFlags: (relPgn) => getFlags(abs(relPgn)),
        docs: () => [
            ...trainingDocs(desktopTrainingStore, "pc"),
            editHistoryDoc(desktopHistoryStore),
        ],
        setFlags: (relPgn, flags) => setFlags(abs(relPgn), flags),
        setPause: (relPgn, state) => setPauseState(abs(relPgn), state),
        moveDecks(fromRel, toRel) {
            const moved = moveDecks(abs(fromRel), abs(toRel));
            info(`sync: ${fromRel} renamed to ${toRel}, ${moved} practice deck(s) moved`);
        },
        setDeck(relPgn, game, deck) {
            const store = getDefaultStore();
            const files = deckFilesFor(relPgn);
            if (files.length === 0) files.push(abs(relPgn));
            for (const file of files) {
                store.set(deckAtomFamily({ file, game: Number(game) }), deck);
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let running: Promise<SyncSummary | null> | null = null;
let rerun = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function doSync(): Promise<SyncSummary | null> {
    const store = getDefaultStore();
    const config = store.get(syncConfigAtom);
    if (!isConfigured(config)) return null;

    store.set(syncStatusAtom, (s) => ({ ...s, state: "syncing", message: undefined }));
    try {
        const folder = await resolveSyncFolder(config);
        const parsed = parseRepository(config.repository)!;
        const key = `${parsed.owner}/${parsed.repo}#${config.branch.trim() || "main"}|${normalizePath(folder)}`;
        const client = createClient(config);
        const env = createTauriEnv(folder);
        let deviceName: string | undefined;
        try {
            deviceName = (await hostname()) ?? undefined;
        } catch {
            deviceName = undefined;
        }

        const result = await retryConcurrent(
            () => {
                const previous = loadManifest();
                const manifest = previous && previous.key === key ? previous : emptyManifest(key);
                return runSync(env, client, manifest, { deviceName });
            },
            { onRetry: (n) => warn(`sync: repository changed during sync, retry ${n}`) },
        );
        saveManifest(result.manifest);
        // Open tabs of the files that changed elsewhere show the new version (unless they
        // have unsaved changes, kept as they are).
        const changed = new Set(result.summary.downloadedFiles ?? []);
        if (changed.size > 0) {
            const tabs = tabsOfFiles((path) => {
                const rel = relativePath(folder, path);
                return rel !== null && changed.has(rel);
            });
            const skipped = await reloadTabs(tabs);
            if (skipped.length > 0) {
                warn(`sync: ${skipped.length} open tab(s) with unsaved changes not reloaded`);
                notifications.show({
                    color: "yellow",
                    autoClose: false,
                    title: i18n.t("Settings.Sync.StaleTabsTitle"),
                    message: i18n.t("Settings.Sync.StaleTabs", {
                        names: skipped.map((t) => t.name).join(", "),
                    }),
                });
            }
        }
        store.set(syncStatusAtom, {
            state: "success",
            lastSync: result.manifest.lastSync,
            summary: result.summary,
        });
        info(`sync: done ${JSON.stringify(result.summary)}`);
        return result.summary;
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        warn(`sync: failed: ${message}`);
        store.set(syncStatusAtom, (s) => ({ ...s, state: "error", message }));
        throw e;
    }
}

/** Runs a sync now (or right after the one in progress). Rejects on failure. */
export function syncNow(): Promise<SyncSummary | null> {
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

/**
 * Requests an automatic sync after `delayMs` of quiet (repeated calls postpone it).
 * If `path` is given, only files inside the sync folder trigger it.
 */
export function scheduleSync(delayMs: number, path?: string) {
    const config = getDefaultStore().get(syncConfigAtom);
    if (!config.auto || !isConfigured(config)) return;
    const start = async () => {
        if (path) {
            const folder = await resolveSyncFolder(config);
            if (relativePath(folder, path) === null) return;
        }
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            syncNow().catch(() => {});
        }, delayMs);
    };
    start().catch(() => {});
}

/** Test the settings: token valid, repository visible and writable. */
export async function testConnection(
    config: SyncConfig,
): Promise<{ private: boolean; push: boolean }> {
    const repo = await createClient(config).getRepo();
    return { private: repo.private, push: repo.permissions?.push ?? false };
}
