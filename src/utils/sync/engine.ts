// Orchestrates one sync run. All side effects go through `SyncEnv` (local files and
// practice decks) and `GitHubClient` (remote), so the algorithm can be tested in memory.

import type { PracticeData } from "@/components/files/opening";
import { mergeFlags, type ReviewFlag } from "@/utils/flags";
import {
    type ContentAction,
    conflictCopyPath,
    detectRenames,
    gitBlobSha,
    isContentPath,
    isEmptyDeck,
    mergeDecks,
    emptyDeck,
    PROGRESS_PREFIX,
    newerPause,
    type PauseState,
    parseProgressFile,
    planContentSync,
    progressPathFor,
    REPERTOIRES_PREFIX,
    serializeProgress,
} from "./core";
import { GitHubError, type GitHubClient, type NewTreeEntry } from "./github";

export interface SyncEnv {
    /** Content files (.pgn/.info) inside the sync folder, as forward-slash relative paths. */
    listLocalFiles(): Promise<string[]>;
    readFile(rel: string): Promise<Uint8Array>;
    writeFile(rel: string, content: Uint8Array): Promise<void>;
    removeFile(rel: string): Promise<void>;
    /** Practice decks of a PGN file in the sync folder, keyed by game index. */
    getDecks(relPgn: string): Record<string, PracticeData>;
    setDeck(relPgn: string, game: string, deck: PracticeData): void;
    /** Moves the practice decks of a renamed/moved PGN (merging into existing ones). */
    moveDecks(fromRelPgn: string, toRelPgn: string): void;
    /** Pause state of a PGN file in the sync folder (null = never paused). */
    getPause(relPgn: string): PauseState | null;
    setPause(relPgn: string, state: PauseState): void;
    /** Moves flagged to review in a PGN file (resolved ones included, as tombstones). */
    getFlags(relPgn: string): ReviewFlag[];
    setFlags(relPgn: string, flags: ReviewFlag[]): void;
    /** Other synced documents (training files), each with its own merge rule. */
    docs?(): SyncDoc[];
}

/** A JSON document kept in the repository outside the repertoires (e.g. training data). */
export type SyncDoc = {
    /** Path in the repository, under "training/". */
    path: string;
    /** Local text, null when this device has none. */
    read(): string | null;
    /** Stores the merged text locally. */
    write(text: string): void;
    /** Local and remote text (remote is null when absent or unchanged since the last sync). */
    merge(local: string | null, remote: string | null): string | null;
    /** Whether this device uploads its version. */
    upload: boolean;
};

export const DOCS_PREFIX = "training/";

export type SyncManifest = {
    /** Identifies repo + branch + folder; the manifest is ignored if they change. */
    key: string;
    head: string | null;
    /** Tree of `head`: when the branch has not moved, the remote state is known. */
    tree?: string;
    /** Content files at the end of the last sync: relative path -> blob sha. */
    files: Record<string, string>;
    /** Progress files at the end of the last sync: remote path -> blob sha. */
    progress: Record<string, string>;
    /** Other documents (training/...) at the end of the last sync: path -> blob sha. */
    docs?: Record<string, string>;
    lastSync: string | null;
};

export type SyncSummary = {
    uploaded: number;
    downloaded: number;
    deleted: number;
    conflicts: string[];
    progressUpdated: number;
    /** Repertoires recognised as renamed or moved (progress follows them). */
    renamed: number;
    committed: boolean;
};

export class ConcurrentPushError extends Error {
    constructor() {
        super("The repository changed during sync");
        this.name = "ConcurrentPushError";
    }
}

/** Rewrites an action so that the remote repository is the only source of truth. */
function toReadOnly(
    action: ContentAction,
    remote: Map<string, string>,
    writable: (rel: string) => boolean,
): ContentAction {
    switch (action.kind) {
        case "upload":
            // A file edited here (comments) goes up when nobody else changed it meanwhile.
            if (writable(action.path) && remote.has(action.path)) return action;
            return remote.has(action.path)
                ? { kind: "download", path: action.path }
                : { kind: "deleteLocal", path: action.path };
        case "conflict":
        case "deleteRemote":
            return remote.has(action.path)
                ? { kind: "download", path: action.path }
                : { kind: "deleteLocal", path: action.path };
        default:
            return action;
    }
}

/**
 * Runs `attempt` again when another device pushed in the middle of it, waiting a bit
 * longer each time (the branch head GitHub reports can lag for a moment after a push).
 */
export async function retryConcurrent<T>(
    attempt: () => Promise<T>,
    options: { delaysMs?: number[]; onRetry?: (n: number) => void } = {},
): Promise<T> {
    const delays = options.delaysMs ?? [500, 1500, 3000, 6000];
    for (let n = 0; ; n++) {
        try {
            return await attempt();
        } catch (e) {
            if (!(e instanceof ConcurrentPushError) || n >= delays.length) throw e;
            options.onRetry?.(n + 1);
            await new Promise((resolve) => setTimeout(resolve, delays[n]));
        }
    }
}

export function emptyManifest(key: string): SyncManifest {
    return { key, head: null, files: {}, progress: {}, lastSync: null };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Requests in flight at once when downloading several files. */
const PARALLEL = 6;

/** Runs `fn` over `items` with at most `limit` calls in flight. */
async function mapLimit<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/** UTF-8 text of a file, or null unless it is valid UTF-8 that encodes back to the same bytes. */
function asText(bytes: Uint8Array): string | null {
    try {
        const text = strictUtf8.decode(bytes);
        const back = encoder.encode(text);
        if (back.length !== bytes.length || back.some((b, i) => b !== bytes[i])) return null;
        return text;
    } catch {
        return null;
    }
}

export async function runSync(
    env: SyncEnv,
    client: GitHubClient,
    previous: SyncManifest,
    options: {
        now?: Date;
        deviceName?: string;
        /**
         * The device never edits repertoires (mobile app): the remote version of the
         * content files always wins and nothing but progress is uploaded.
         */
        readOnlyContent?: boolean;
        /**
         * With readOnlyContent: files this device edited, uploaded if the remote copy
         * did not change since the last sync (otherwise the remote copy still wins and
         * the device applies its edits again on top of it).
         */
        writable?: (rel: string) => boolean;
    } = {},
): Promise<{ manifest: SyncManifest; summary: SyncSummary }> {
    const now = options.now ?? new Date();
    const summary: SyncSummary = {
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: [],
        progressUpdated: 0,
        renamed: 0,
        committed: false,
    };

    // 1. Remote state
    let head = await client.getHead();
    if (head === null) head = await client.initBranch();
    let baseTree: string;
    const remoteContent = new Map<string, string>();
    const remoteProgress = new Map<string, string>();
    const remoteDocs = new Map<string, string>();
    if (previous.tree && previous.head === head) {
        // Nothing was pushed since our last sync: the remote is what we left there.
        baseTree = previous.tree;
        for (const [rel, sha] of Object.entries(previous.files)) remoteContent.set(rel, sha);
        for (const [path, sha] of Object.entries(previous.progress)) remoteProgress.set(path, sha);
        for (const [path, sha] of Object.entries(previous.docs ?? {})) remoteDocs.set(path, sha);
    } else {
        baseTree = await client.getCommitTree(head);
        for (const entry of await client.getTree(baseTree)) {
            if (entry.path.startsWith(REPERTOIRES_PREFIX)) {
                const rel = entry.path.slice(REPERTOIRES_PREFIX.length);
                if (isContentPath(rel)) remoteContent.set(rel, entry.sha);
            } else if (entry.path.startsWith(PROGRESS_PREFIX) && entry.path.endsWith(".json")) {
                remoteProgress.set(entry.path, entry.sha);
            } else if (entry.path.startsWith(DOCS_PREFIX) && entry.path.endsWith(".json")) {
                remoteDocs.set(entry.path, entry.sha);
            }
        }
    }

    // 2. Local state
    const localContent = new Map<string, string>();
    const localBytes = new Map<string, Uint8Array>();
    for (const rel of await env.listLocalFiles()) {
        const bytes = await env.readFile(rel);
        localBytes.set(rel, bytes);
        localContent.set(rel, await gitBlobSha(bytes));
    }

    // 3. Content files
    const base = new Map(Object.entries(previous.files));
    let actions: ContentAction[] = planContentSync(localContent, remoteContent, base);
    if (options.readOnlyContent) {
        const writable = options.writable ?? (() => false);
        actions = actions.map((a) => toReadOnly(a, remoteContent, writable));
    }
    const entries: NewTreeEntry[] = [];
    const finalContent = new Map(localContent);

    const upload = async (rel: string, bytes: Uint8Array) => {
        const path = REPERTOIRES_PREFIX + rel;
        const text = asText(bytes);
        // Text goes straight into the tree; only non-UTF-8 files need a blob request.
        if (text !== null) {
            entries.push({ path, mode: "100644", type: "blob", content: text });
            finalContent.set(rel, await gitBlobSha(bytes));
        } else {
            const sha = await client.createBlob(bytes);
            entries.push({ path, mode: "100644", type: "blob", sha });
            finalContent.set(rel, sha);
        }
        summary.uploaded++;
    };

    // Remote files this sync needs, downloaded in parallel.
    const fetched = new Map<string, Uint8Array>();
    const prefetch = async (shas: (string | undefined)[]) => {
        const missing = [...new Set(shas.filter((s): s is string => !!s && !fetched.has(s)))];
        const blobs = await mapLimit(missing, PARALLEL, (sha) => client.getBlob(sha));
        missing.forEach((sha, i) => fetched.set(sha, blobs[i]));
    };
    const blob = async (sha: string) => fetched.get(sha) ?? (await client.getBlob(sha));
    await prefetch(
        actions
            .filter((a) => a.kind === "download" || a.kind === "conflict")
            .map((a) => remoteContent.get(a.path)),
    );

    // Renamed/moved repertoires keep their progress. Decks are moved before any file is
    // deleted; for local renames the old remote progress is merged into the new path.
    const renamedProgress = new Map<string, string>();
    for (const rename of detectRenames(actions, localContent, remoteContent)) {
        env.moveDecks(rename.from, rename.to);
        const oldProgress = remoteProgress.get(progressPathFor(rename.from));
        if (rename.side === "local" && oldProgress) renamedProgress.set(rename.to, oldProgress);
        summary.renamed++;
    }

    for (const action of actions) {
        const rel = action.path;
        switch (action.kind) {
            case "download": {
                const sha = remoteContent.get(rel)!;
                await env.writeFile(rel, await blob(sha));
                finalContent.set(rel, sha);
                summary.downloaded++;
                break;
            }
            case "deleteLocal":
                await env.removeFile(rel);
                finalContent.delete(rel);
                summary.deleted++;
                break;
            case "deleteRemote":
                entries.push({
                    path: REPERTOIRES_PREFIX + rel,
                    mode: "100644",
                    type: "blob",
                    sha: null,
                });
                finalContent.delete(rel);
                summary.deleted++;
                break;
            case "upload":
                await upload(rel, localBytes.get(rel)!);
                break;
            case "conflict": {
                // Keep our version under the original name, save theirs next to it.
                const copy = conflictCopyPath(rel, now);
                const theirs = await blob(remoteContent.get(rel)!);
                await env.writeFile(copy, theirs);
                await upload(rel, localBytes.get(rel)!);
                await upload(copy, theirs);
                summary.conflicts.push(rel);
                break;
            }
        }
    }

    // 4. Practice progress, one JSON per PGN
    const progressManifest: Record<string, string> = {};
    const pgnFiles = [...finalContent.keys()].filter((p) => p.toLowerCase().endsWith(".pgn"));
    const wantedProgress = new Set<string>();
    const remoteShaOf = (relPgn: string) =>
        remoteProgress.get(progressPathFor(relPgn)) ?? renamedProgress.get(relPgn);
    await prefetch(
        pgnFiles
            .map(remoteShaOf)
            .filter((sha, i) => sha !== previous.progress[progressPathFor(pgnFiles[i])]),
    );

    for (const relPgn of pgnFiles) {
        const progressPath = progressPathFor(relPgn);
        wantedProgress.add(progressPath);
        const shaAtPath = remoteProgress.get(progressPath);
        const remoteSha = shaAtPath ?? renamedProgress.get(relPgn);

        // Download only if it changed since our last sync: otherwise everything in it
        // was already merged into the local decks.
        let remoteGames: Record<string, PracticeData> = {};
        let remotePause: PauseState | null = null;
        let remoteFlags: ReviewFlag[] = [];
        if (remoteSha && remoteSha !== previous.progress[progressPath]) {
            try {
                const remote = parseProgressFile(decoder.decode(await blob(remoteSha)));
                remoteGames = remote.games;
                remotePause = remote.pause;
                remoteFlags = remote.flags;
            } catch {
                remoteGames = {};
            }
        }

        // Pause: the most recent change (from any device) wins.
        const localPause = env.getPause(relPgn);
        const pause = newerPause(localPause, remotePause);
        if (pause && pause !== localPause) {
            env.setPause(relPgn, pause);
            summary.progressUpdated++;
        }

        // Flags to review: union by id, the newest version of each wins.
        const localFlags = env.getFlags(relPgn);
        const flags = mergeFlags(localFlags, remoteFlags, now);
        if (JSON.stringify(flags) !== JSON.stringify(localFlags)) {
            env.setFlags(relPgn, flags);
            summary.progressUpdated++;
        }

        const localGames = env.getDecks(relPgn);
        const merged: Record<string, PracticeData> = {};
        for (const game of new Set([...Object.keys(localGames), ...Object.keys(remoteGames)])) {
            const local = localGames[game] ?? emptyDeck();
            const deck = mergeDecks(local, remoteGames[game] ?? emptyDeck());
            if (JSON.stringify(deck) !== JSON.stringify(local)) {
                env.setDeck(relPgn, game, deck);
                summary.progressUpdated++;
            }
            if (!isEmptyDeck(deck)) merged[game] = deck;
        }

        if (Object.keys(merged).length === 0 && !pause && flags.length === 0) {
            if (shaAtPath) progressManifest[progressPath] = shaAtPath;
            continue;
        }
        const text = serializeProgress(merged, pause, flags);
        const sha = await gitBlobSha(encoder.encode(text));
        if (sha !== shaAtPath) {
            entries.push({ path: progressPath, mode: "100644", type: "blob", content: text });
        }
        progressManifest[progressPath] = sha;
    }

    // Progress of PGN files that no longer exist
    for (const path of remoteProgress.keys()) {
        if (!wantedProgress.has(path)) {
            entries.push({ path, mode: "100644", type: "blob", sha: null });
        }
    }

    // 4b. Other documents (training data)
    const docsManifest: Record<string, string> = {};
    for (const doc of env.docs?.() ?? []) {
        const remoteSha = remoteDocs.get(doc.path);
        let remoteText: string | null = null;
        if (remoteSha && remoteSha !== previous.docs?.[doc.path]) {
            remoteText = decoder.decode(await blob(remoteSha));
        }
        const local = doc.read();
        const merged = doc.merge(local, remoteText);
        if (merged !== null && merged !== local) {
            doc.write(merged);
            summary.progressUpdated++;
        }
        if (doc.upload && merged !== null) {
            const sha = await gitBlobSha(encoder.encode(merged));
            if (sha !== remoteSha) {
                entries.push({ path: doc.path, mode: "100644", type: "blob", content: merged });
            }
            docsManifest[doc.path] = sha;
        } else if (remoteSha) {
            docsManifest[doc.path] = remoteSha;
        }
    }

    // 5. Commit
    let newHead = head;
    let newTree = baseTree;
    if (entries.length > 0) {
        const tree = await client.createTree(baseTree, entries);
        newTree = tree;
        const device = options.deviceName ? ` from ${options.deviceName}` : "";
        const commit = await client.createCommit(`Sync${device} ${now.toISOString()}`, tree, head);
        try {
            await client.updateHead(commit);
        } catch (e) {
            if (e instanceof GitHubError && e.status === 422) throw new ConcurrentPushError();
            throw e;
        }
        newHead = commit;
        summary.committed = true;
    }

    return {
        manifest: {
            key: previous.key,
            head: newHead,
            tree: newTree,
            files: Object.fromEntries(finalContent),
            progress: progressManifest,
            docs: docsManifest,
            lastSync: now.toISOString(),
        },
        summary,
    };
}
