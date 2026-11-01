// Orchestrates one sync run. All side effects go through `SyncEnv` (local files and
// practice decks) and `GitHubClient` (remote), so the algorithm can be tested in memory.

import type { PracticeData } from "@/components/files/opening";
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
    parseProgress,
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
}

export type SyncManifest = {
    /** Identifies repo + branch + folder; the manifest is ignored if they change. */
    key: string;
    head: string | null;
    /** Content files at the end of the last sync: relative path -> blob sha. */
    files: Record<string, string>;
    /** Progress files at the end of the last sync: remote path -> blob sha. */
    progress: Record<string, string>;
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
function toReadOnly(action: ContentAction, remote: Map<string, string>): ContentAction {
    switch (action.kind) {
        case "upload":
        case "conflict":
        case "deleteRemote":
            return remote.has(action.path)
                ? { kind: "download", path: action.path }
                : { kind: "deleteLocal", path: action.path };
        default:
            return action;
    }
}

export function emptyManifest(key: string): SyncManifest {
    return { key, head: null, files: {}, progress: {}, lastSync: null };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
    const baseTree = await client.getCommitTree(head);
    const remoteEntries = await client.getTree(baseTree);

    const remoteContent = new Map<string, string>();
    const remoteProgress = new Map<string, string>();
    for (const entry of remoteEntries) {
        if (entry.path.startsWith(REPERTOIRES_PREFIX)) {
            const rel = entry.path.slice(REPERTOIRES_PREFIX.length);
            if (isContentPath(rel)) remoteContent.set(rel, entry.sha);
        } else if (entry.path.startsWith(PROGRESS_PREFIX) && entry.path.endsWith(".json")) {
            remoteProgress.set(entry.path, entry.sha);
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
    if (options.readOnlyContent) actions = actions.map((a) => toReadOnly(a, remoteContent));
    const entries: NewTreeEntry[] = [];
    const finalContent = new Map(localContent);

    const upload = async (rel: string, bytes: Uint8Array) => {
        const sha = await client.createBlob(bytes);
        entries.push({ path: REPERTOIRES_PREFIX + rel, mode: "100644", type: "blob", sha });
        finalContent.set(rel, sha);
        summary.uploaded++;
    };

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
                await env.writeFile(rel, await client.getBlob(sha));
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
                const theirs = await client.getBlob(remoteContent.get(rel)!);
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

    for (const relPgn of pgnFiles) {
        const progressPath = progressPathFor(relPgn);
        wantedProgress.add(progressPath);
        const shaAtPath = remoteProgress.get(progressPath);
        const remoteSha = shaAtPath ?? renamedProgress.get(relPgn);

        // Download only if it changed since our last sync: otherwise everything in it
        // was already merged into the local decks.
        let remoteGames: Record<string, PracticeData> = {};
        if (remoteSha && remoteSha !== previous.progress[progressPath]) {
            try {
                remoteGames = parseProgress(decoder.decode(await client.getBlob(remoteSha)));
            } catch {
                remoteGames = {};
            }
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

        if (Object.keys(merged).length === 0) {
            if (shaAtPath) progressManifest[progressPath] = shaAtPath;
            continue;
        }
        const bytes = encoder.encode(serializeProgress(merged));
        let sha = await gitBlobSha(bytes);
        if (sha !== shaAtPath) {
            sha = await client.createBlob(bytes);
            entries.push({ path: progressPath, mode: "100644", type: "blob", sha });
        }
        progressManifest[progressPath] = sha;
    }

    // Progress of PGN files that no longer exist
    for (const path of remoteProgress.keys()) {
        if (!wantedProgress.has(path)) {
            entries.push({ path, mode: "100644", type: "blob", sha: null });
        }
    }

    // 5. Commit
    let newHead = head;
    if (entries.length > 0) {
        const tree = await client.createTree(baseTree, entries);
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
            files: Object.fromEntries(finalContent),
            progress: progressManifest,
            lastSync: now.toISOString(),
        },
        summary,
    };
}
