import { describe, expect, test } from "vitest";
import type { PracticeData } from "@/state/atoms";
import {
    type PauseState,
    parseProgressFile,
    conflictCopyPath,
    gitBlobSha,
    mergeDecks,
    parseDeckKey,
    parseProgress,
    planContentSync,
    progressPathFor,
    relativePath,
    serializeProgress,
} from "../sync/core";
import {
    ConcurrentPushError,
    emptyManifest,
    retryConcurrent,
    runSync,
    type SyncEnv,
} from "../sync/engine";
import { flagAt, type ReviewFlag, resolveFlag, setFlag } from "../flags";
import { setMoveComment } from "../pgnEdit";
import { GitHubClient, GitHubError, type NewTreeEntry, type TreeEntry } from "../sync/github";

const enc = new TextEncoder();
const dec = new TextDecoder();

function card(lastReview: string | undefined, reps: number, due = "2026-01-01T00:00:00.000Z") {
    return {
        due,
        stability: 1,
        difficulty: 5,
        elapsed_days: 0,
        scheduled_days: 1,
        reps,
        lapses: 0,
        state: reps > 0 ? 2 : 0,
        last_review: lastReview,
    } as unknown as PracticeData["positions"][number]["card"];
}

function log(fen: string, review: string, rating = 3) {
    return { fen, review, rating } as unknown as PracticeData["logs"][number];
}

describe("core", () => {
    test("gitBlobSha matches git", async () => {
        // `printf 'hello\n' | git hash-object --stdin`
        expect(await gitBlobSha(enc.encode("hello\n"))).toBe(
            "ce013625030ba8dba906f756967f9e9ca394464a",
        );
    });

    test("relativePath", () => {
        expect(relativePath("C:\\Users\\me\\Rep", "C:\\Users\\me\\Rep\\a\\b.pgn")).toBe("a/b.pgn");
        expect(relativePath("c:/users/me/rep/", "C:\\Users\\me\\Rep\\b.pgn")).toBe("b.pgn");
        expect(relativePath("C:\\Users\\me\\Rep", "C:\\Users\\me\\Repertoire\\b.pgn")).toBeNull();
        expect(relativePath("C:\\Users\\me\\Rep", "C:\\Users\\me\\Rep")).toBeNull();
    });

    test("progressPathFor and conflictCopyPath", () => {
        expect(progressPathFor("Openings/Sicilian.pgn")).toBe("progress/Openings/Sicilian.json");
        expect(conflictCopyPath("a/Sicilian.pgn", new Date(2026, 10, 1, 15, 30))).toBe(
            "a/Sicilian (conflict 2026-11-01 1530).pgn",
        );
    });

    test("parseDeckKey", () => {
        expect(parseDeckKey("deck-C:\\x\\my-rep.pgn-3")).toEqual({
            file: "C:\\x\\my-rep.pgn",
            game: 3,
        });
        expect(parseDeckKey("deck--0")).toBeNull();
        expect(parseDeckKey("other")).toBeNull();
    });

    test("planContentSync three-way cases", () => {
        const local = new Map([
            ["same.pgn", "1"],
            ["localChanged.pgn", "L"],
            ["remoteChanged.pgn", "B"],
            ["both.pgn", "L"],
            ["newLocal.pgn", "N"],
            ["remoteDeleted.pgn", "B"],
        ]);
        const remote = new Map([
            ["same.pgn", "1"],
            ["localChanged.pgn", "B"],
            ["remoteChanged.pgn", "R"],
            ["both.pgn", "R"],
            ["newRemote.pgn", "N"],
            ["localDeleted.pgn", "B"],
        ]);
        const base = new Map([
            ["same.pgn", "1"],
            ["localChanged.pgn", "B"],
            ["remoteChanged.pgn", "B"],
            ["both.pgn", "B"],
            ["remoteDeleted.pgn", "B"],
            ["localDeleted.pgn", "B"],
        ]);
        const actions = Object.fromEntries(
            planContentSync(local, remote, base).map((a) => [a.path, a.kind]),
        );
        expect(actions).toEqual({
            "localChanged.pgn": "upload",
            "remoteChanged.pgn": "download",
            "both.pgn": "conflict",
            "newLocal.pgn": "upload",
            "newRemote.pgn": "download",
            "remoteDeleted.pgn": "deleteLocal",
            "localDeleted.pgn": "deleteRemote",
        });
    });

    test("planContentSync first sync never deletes", () => {
        const actions = planContentSync(
            new Map([["a.pgn", "1"]]),
            new Map([["b.pgn", "2"]]),
            new Map(),
        );
        expect(actions).toEqual([
            { kind: "upload", path: "a.pgn" },
            { kind: "download", path: "b.pgn" },
        ]);
    });

    test("mergeDecks keeps local positions, newest card and union of logs", () => {
        const local: PracticeData = {
            positions: [
                { fen: "A", answer: "e4", card: card("2026-10-01T10:00:00Z", 3) },
                { fen: "B", answer: "d4", card: card("2026-10-05T10:00:00Z", 2) },
            ],
            logs: [log("A", "2026-10-01T10:00:00Z"), log("B", "2026-10-05T10:00:00Z")],
        };
        const remote: PracticeData = {
            positions: [
                { fen: "A", answer: "e4", card: card("2026-10-10T10:00:00Z", 4) },
                { fen: "B", answer: "d4", card: card("2026-10-02T10:00:00Z", 1) },
                { fen: "OLD", answer: "c4", card: card("2026-10-02T10:00:00Z", 1) },
            ],
            logs: [log("A", "2026-10-01T10:00:00Z"), log("A", "2026-10-10T10:00:00Z", 4)],
        };
        const merged = mergeDecks(local, remote);
        expect(merged.positions.map((p) => p.fen)).toEqual(["A", "B"]);
        expect(merged.positions[0].card.reps).toBe(4);
        expect(merged.positions[1].card.reps).toBe(2);
        expect(merged.logs).toHaveLength(3);
        expect(merged.logs.map((l) => l.fen)).toEqual(["A", "B", "A"]);
    });

    test("mergeDecks takes remote positions when local deck is empty", () => {
        const remote: PracticeData = {
            positions: [{ fen: "A", answer: "e4", card: card("2026-10-10T10:00:00Z", 4) }],
            logs: [],
        };
        expect(mergeDecks({ positions: [], logs: [] }, remote)).toEqual(remote);
    });

    test("serializeProgress is stable and round-trips", () => {
        const games = { "10": { positions: [], logs: [] }, "2": { positions: [], logs: [] } };
        const text = serializeProgress(games);
        expect(text.indexOf('"2"')).toBeLessThan(text.indexOf('"10"'));
        expect(parseProgress(text)).toEqual(games);
    });

    test("serializeProgress does not depend on key order", () => {
        const a = { "0": { positions: [], logs: [{ fen: "x", rating: 3, review: "r" }] } };
        const b = { "0": { logs: [{ review: "r", rating: 3, fen: "x" }], positions: [] } };
        expect(serializeProgress(a as never)).toBe(serializeProgress(b as never));
    });
});

// ---------------------------------------------------------------------------
// In-memory GitHub + environment
// ---------------------------------------------------------------------------

class FakeRepo {
    blobs = new Map<string, Uint8Array>();
    trees = new Map<string, Map<string, string>>();
    commits = new Map<string, { tree: string; parent: string | null; message: string }>();
    head: string | null = null;
    counter = 0;
    /** Simulates another device pushing right before our ref update. */
    racePushes = 0;

    async putBlob(bytes: Uint8Array) {
        const sha = await gitBlobSha(bytes);
        this.blobs.set(sha, bytes);
        return sha;
    }

    files(): Map<string, string> {
        if (!this.head) return new Map();
        return this.trees.get(this.commits.get(this.head)!.tree)!;
    }

    text(path: string): string | undefined {
        const sha = this.files().get(path);
        return sha ? dec.decode(this.blobs.get(sha)!) : undefined;
    }

    async commitFiles(files: Record<string, string | null>) {
        const tree = new Map(this.files());
        for (const [path, content] of Object.entries(files)) {
            if (content === null) tree.delete(path);
            else tree.set(path, await this.putBlob(enc.encode(content)));
        }
        const treeSha = `tree${this.counter++}`;
        this.trees.set(treeSha, tree);
        const commit = `commit${this.counter++}`;
        this.commits.set(commit, { tree: treeSha, parent: this.head, message: "external" });
        this.head = commit;
    }
}

class FakeClient {
    constructor(private repo: FakeRepo) {}
    async getHead() {
        return this.repo.head;
    }
    async initBranch() {
        await this.repo.commitFiles({ "README.md": "hi" });
        return this.repo.head!;
    }
    async getCommitTree(sha: string) {
        return this.repo.commits.get(sha)!.tree;
    }
    async getTree(sha: string): Promise<TreeEntry[]> {
        return [...this.repo.trees.get(sha)!].map(([path, s]) => ({
            path,
            sha: s,
            type: "blob",
            mode: "100644",
        }));
    }
    async getBlob(sha: string) {
        return this.repo.blobs.get(sha)!;
    }
    async createBlob(bytes: Uint8Array) {
        return this.repo.putBlob(bytes);
    }
    async createTree(base: string | null, entries: NewTreeEntry[]) {
        const tree = new Map(base ? this.repo.trees.get(base)! : []);
        for (const e of entries) {
            if ("content" in e) tree.set(e.path, await this.repo.putBlob(enc.encode(e.content)));
            else if (e.sha === null) tree.delete(e.path);
            else tree.set(e.path, e.sha);
        }
        const sha = `tree${this.repo.counter++}`;
        this.repo.trees.set(sha, tree);
        return sha;
    }
    async createCommit(message: string, tree: string, parent: string | null) {
        const sha = `commit${this.repo.counter++}`;
        this.repo.commits.set(sha, { tree, parent, message });
        return sha;
    }
    async updateHead(sha: string) {
        if (this.repo.racePushes > 0) {
            this.repo.racePushes--;
            await this.repo.commitFiles({ "race.txt": String(this.repo.counter) });
        }
        if (this.repo.commits.get(sha)!.parent !== this.repo.head)
            throw new GitHubError("422 not ff", 422);
        this.repo.head = sha;
    }
}

class MemoryEnv implements SyncEnv {
    files = new Map<string, Uint8Array>();
    decks = new Map<string, Record<string, PracticeData>>();
    pauses = new Map<string, PauseState>();
    flags = new Map<string, ReviewFlag[]>();
    getFlags(rel: string) {
        return structuredClone(this.flags.get(rel) ?? []);
    }
    setFlags(rel: string, flags: ReviewFlag[]) {
        this.flags.set(rel, structuredClone(flags));
    }
    getPause(rel: string) {
        return this.pauses.get(rel) ?? null;
    }
    setPause(rel: string, state: PauseState) {
        this.pauses.set(rel, state);
    }
    async listLocalFiles() {
        return [...this.files.keys()];
    }
    async readFile(rel: string) {
        return this.files.get(rel)!;
    }
    async writeFile(rel: string, content: Uint8Array) {
        this.files.set(rel, content);
    }
    async removeFile(rel: string) {
        this.files.delete(rel);
    }
    getDecks(rel: string) {
        return structuredClone(this.decks.get(rel) ?? {});
    }
    setDeck(rel: string, game: string, deck: PracticeData) {
        this.decks.set(rel, { ...(this.decks.get(rel) ?? {}), [game]: structuredClone(deck) });
    }
    moveDecks(from: string, to: string) {
        const old = this.decks.get(from);
        if (!old) return;
        const target = { ...(this.decks.get(to) ?? {}) };
        for (const [game, deck] of Object.entries(old)) {
            target[game] = mergeDecks(target[game] ?? { positions: [], logs: [] }, deck);
        }
        this.decks.set(to, target);
        this.decks.delete(from);
        const pause = this.pauses.get(from);
        if (pause) {
            this.pauses.set(to, pause);
            this.pauses.delete(from);
        }
        const flags = this.flags.get(from);
        if (flags) {
            this.flags.set(to, flags);
            this.flags.delete(from);
        }
    }
    put(rel: string, text: string) {
        this.files.set(rel, enc.encode(text));
    }
    text(rel: string) {
        const f = this.files.get(rel);
        return f ? dec.decode(f) : undefined;
    }
}

function client(repo: FakeRepo) {
    return new FakeClient(repo) as unknown as GitHubClient;
}

describe("runSync", () => {
    test("first sync uploads repertoire and progress, second sync is a no-op", async () => {
        const repo = new FakeRepo();
        const env = new MemoryEnv();
        env.put("White.pgn", "1. e4 *");
        env.put("White.info", '{"type":"repertoire","tags":[]}');
        env.setDeck("White.pgn", "0", {
            positions: [{ fen: "A", answer: "e4", card: card("2026-10-01T10:00:00Z", 1) }],
            logs: [log("A", "2026-10-01T10:00:00Z")],
        });

        const first = await runSync(env, client(repo), emptyManifest("k"));
        expect(first.summary.committed).toBe(true);
        expect(repo.text("repertoires/White.pgn")).toBe("1. e4 *");
        expect(repo.text("repertoires/White.info")).toContain("repertoire");
        const progress = parseProgress(repo.text("progress/White.json")!);
        expect(progress["0"].positions[0].fen).toBe("A");

        const head = repo.head;
        const second = await runSync(env, client(repo), first.manifest);
        expect(second.summary.committed).toBe(false);
        expect(repo.head).toBe(head);
    });

    test("progress made on another device is merged locally", async () => {
        const repo = new FakeRepo();
        const pc = new MemoryEnv();
        pc.put("White.pgn", "1. e4 *");
        pc.setDeck("White.pgn", "0", {
            positions: [
                { fen: "A", answer: "e4", card: card("2026-10-01T10:00:00Z", 1) },
                { fen: "B", answer: "Nf3", card: card(undefined, 0) },
            ],
            logs: [log("A", "2026-10-01T10:00:00Z")],
        });
        const first = await runSync(pc, client(repo), emptyManifest("k"));

        // The phone reviews position B and pushes new progress.
        const phoneProgress = parseProgress(repo.text("progress/White.json")!);
        phoneProgress["0"].positions[1].card = card("2026-10-20T08:00:00Z", 1);
        phoneProgress["0"].logs.push(log("B", "2026-10-20T08:00:00Z"));
        await repo.commitFiles({ "progress/White.json": serializeProgress(phoneProgress) });

        // Meanwhile the PC reviews position A.
        const deck = pc.getDecks("White.pgn")["0"];
        deck.positions[0].card = card("2026-10-21T08:00:00Z", 2);
        deck.logs.push(log("A", "2026-10-21T08:00:00Z"));
        pc.setDeck("White.pgn", "0", deck);

        const second = await runSync(pc, client(repo), first.manifest);
        const merged = pc.getDecks("White.pgn")["0"];
        expect(merged.positions[0].card.reps).toBe(2);
        expect(merged.positions[1].card.reps).toBe(1);
        expect(merged.logs).toHaveLength(3);
        expect(parseProgress(repo.text("progress/White.json")!)["0"]).toEqual(merged);
        expect(second.summary.progressUpdated).toBe(1);
    });

    test("a new PC downloads repertoires and progress", async () => {
        const repo = new FakeRepo();
        const pc1 = new MemoryEnv();
        pc1.put("dir/Black.pgn", "1. e4 c5 *");
        pc1.setDeck("dir/Black.pgn", "0", {
            positions: [{ fen: "A", answer: "c5", card: card("2026-10-01T10:00:00Z", 1) }],
            logs: [],
        });
        await runSync(pc1, client(repo), emptyManifest("k"));

        const pc2 = new MemoryEnv();
        await runSync(pc2, client(repo), emptyManifest("k"));
        expect(pc2.text("dir/Black.pgn")).toBe("1. e4 c5 *");
        expect(pc2.getDecks("dir/Black.pgn")["0"].positions[0].fen).toBe("A");
    });

    test("deleting a repertoire locally removes it and its progress remotely", async () => {
        const repo = new FakeRepo();
        const env = new MemoryEnv();
        env.put("White.pgn", "1. e4 *");
        env.setDeck("White.pgn", "0", {
            positions: [{ fen: "A", answer: "e4", card: card(undefined, 0) }],
            logs: [],
        });
        const first = await runSync(env, client(repo), emptyManifest("k"));
        env.files.delete("White.pgn");
        await runSync(env, client(repo), first.manifest);
        expect(repo.text("repertoires/White.pgn")).toBeUndefined();
        expect(repo.text("progress/White.json")).toBeUndefined();
    });

    test("conflicting edits keep both versions", async () => {
        const repo = new FakeRepo();
        const env = new MemoryEnv();
        env.put("White.pgn", "1. e4 *");
        const first = await runSync(env, client(repo), emptyManifest("k"));
        await repo.commitFiles({ "repertoires/White.pgn": "1. d4 *" });
        env.put("White.pgn", "1. c4 *");
        const now = new Date(2026, 10, 1, 9, 5);
        const second = await runSync(env, client(repo), first.manifest, { now });
        expect(second.summary.conflicts).toEqual(["White.pgn"]);
        expect(env.text("White.pgn")).toBe("1. c4 *");
        expect(env.text("White (conflict 2026-11-01 0905).pgn")).toBe("1. d4 *");
        expect(repo.text("repertoires/White.pgn")).toBe("1. c4 *");
        expect(repo.text("repertoires/White (conflict 2026-11-01 0905).pgn")).toBe("1. d4 *");
    });

    test("a concurrent push is reported so the caller can retry", async () => {
        const repo = new FakeRepo();
        const env = new MemoryEnv();
        env.put("White.pgn", "1. e4 *");
        repo.racePushes = 1;
        await expect(runSync(env, client(repo), emptyManifest("k"))).rejects.toBeInstanceOf(
            ConcurrentPushError,
        );
        const retry = await runSync(env, client(repo), emptyManifest("k"));
        expect(retry.summary.committed).toBe(true);
        expect(repo.text("repertoires/White.pgn")).toBe("1. e4 *");
        expect(repo.text("race.txt")).toBeDefined();
    });
});

/** Client that counts the requests and can answer the branch head from a stale cache. */
function countingClient(repo: FakeRepo, staleHeads: (string | null)[] = []) {
    const base = new FakeClient(repo);
    const calls: string[] = [];
    const wrapped = new Proxy(base, {
        get(target, prop: string) {
            const value = (target as unknown as Record<string, unknown>)[prop];
            if (typeof value !== "function") return value;
            return async (...args: unknown[]) => {
                calls.push(prop);
                if (prop === "getHead" && staleHeads.length > 0) return staleHeads.shift();
                return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
        },
    });
    return { client: wrapped as unknown as GitHubClient, calls };
}

describe("speed and reliability", () => {
    test("a sync with nothing new costs a single request", async () => {
        const repo = new FakeRepo();
        const env = new MemoryEnv();
        env.put("White.pgn", "1. e4 *");
        env.setDeck("White.pgn", "0", {
            positions: [{ fen: "A", answer: "e4", card: card("2026-10-01T10:00:00Z", 1) }],
            logs: [log("A", "2026-10-01T10:00:00Z")],
        });
        const first = await runSync(env, client(repo), emptyManifest("k"));
        const { client: c, calls } = countingClient(repo);
        const second = await runSync(env, c, first.manifest);
        expect(second.summary.committed).toBe(false);
        expect(calls).toEqual(["getHead"]);
    });

    test("new progress is committed without blob requests", async () => {
        const repo = new FakeRepo();
        const env = new MemoryEnv();
        env.put("White.pgn", "1. e4 *");
        const first = await runSync(env, client(repo), emptyManifest("k"));
        env.setDeck("White.pgn", "0", {
            positions: [{ fen: "A", answer: "e4", card: card("2026-10-02T10:00:00Z", 1) }],
            logs: [log("A", "2026-10-02T10:00:00Z")],
        });
        const { client: c, calls } = countingClient(repo);
        const second = await runSync(env, c, first.manifest);
        expect(calls).toEqual(["getHead", "createTree", "createCommit", "updateHead"]);
        expect(parseProgress(repo.text("progress/White.json")!)["0"].positions[0].fen).toBe("A");
        // And the next sync knows the remote state without asking.
        const { client: c2, calls: calls2 } = countingClient(repo);
        await runSync(env, c2, second.manifest);
        expect(calls2).toEqual(["getHead"]);
    });

    test("a stale branch head (HTTP cache) is retried until the push goes through", async () => {
        const repo = new FakeRepo();
        const phone = new MemoryEnv();
        phone.put("White.pgn", "1. e4 *");
        const first = await runSync(phone, client(repo), emptyManifest("k"));
        // Another device pushes; the phone keeps seeing the old head twice.
        const oldHead = repo.head;
        await repo.commitFiles({ "repertoires/Black.pgn": "1. e4 c5 *" });
        phone.setDeck("White.pgn", "0", {
            positions: [{ fen: "A", answer: "e4", card: card("2026-10-02T10:00:00Z", 1) }],
            logs: [],
        });
        const { client: c } = countingClient(repo, [oldHead, oldHead]);
        let manifest = first.manifest;
        const retries: number[] = [];
        const result = await retryConcurrent(
            async () => {
                const r = await runSync(phone, c, manifest);
                manifest = r.manifest;
                return r;
            },
            { delaysMs: [0, 0, 0, 0], onRetry: (n) => retries.push(n) },
        );
        expect(retries).toEqual([1, 2]);
        expect(result.summary.committed).toBe(true);
        expect(phone.text("Black.pgn")).toBe("1. e4 c5 *");
        expect(repo.text("repertoires/Black.pgn")).toBe("1. e4 c5 *");
        expect(parseProgress(repo.text("progress/White.json")!)["0"].positions[0].fen).toBe("A");
    });

    test("files with a byte order mark keep their exact bytes", async () => {
        const raw = new TextDecoder("utf-8", { ignoreBOM: true });
        const bytes = enc.encode("\uFEFF1. e4 *");
        const repo = new FakeRepo();
        const env = new MemoryEnv();
        env.files.set("White.pgn", bytes);
        const first = await runSync(env, client(repo), emptyManifest("k"));
        const remote = repo.blobs.get(repo.files().get("repertoires/White.pgn")!)!;
        expect(raw.decode(remote)).toBe("\uFEFF1. e4 *");
        const second = await runSync(env, client(repo), first.manifest);
        expect(second.summary.committed).toBe(false);
        const pc2 = new MemoryEnv();
        await runSync(pc2, client(repo), emptyManifest("k2"));
        expect(raw.decode(pc2.files.get("White.pgn")!)).toBe("\uFEFF1. e4 *");
    });
});

describe("comments edited on the phone", () => {
    const PGN = "1. e4 e5 2. Nf3 *";
    test("an edited PGN goes up from the phone and reaches the PC", async () => {
        const repo = new FakeRepo();
        const pc = new MemoryEnv();
        pc.put("White.pgn", PGN);
        const pcFirst = await runSync(pc, client(repo), emptyManifest("pc"));
        const phone = new MemoryEnv();
        const phoneFirst = await runSync(phone, client(repo), emptyManifest("ph"), {
            readOnlyContent: true,
        });
        phone.put("White.pgn", setMoveComment(PGN, 0, ["e4", "e5", "Nf3"], "Sviluppo")!);
        const writable = (rel: string) => rel === "White.pgn";
        const second = await runSync(phone, client(repo), phoneFirst.manifest, {
            readOnlyContent: true,
            writable,
        });
        expect(second.summary.uploaded).toBe(1);
        expect(repo.text("repertoires/White.pgn")).toBe("1. e4 e5 2. Nf3 {Sviluppo} *");
        await runSync(pc, client(repo), pcFirst.manifest);
        expect(pc.text("White.pgn")).toBe("1. e4 e5 2. Nf3 {Sviluppo} *");
    });

    test("not writable: the phone's copy is replaced as before", async () => {
        const repo = new FakeRepo();
        const pc = new MemoryEnv();
        pc.put("White.pgn", PGN);
        await runSync(pc, client(repo), emptyManifest("pc"));
        const phone = new MemoryEnv();
        const first = await runSync(phone, client(repo), emptyManifest("ph"), {
            readOnlyContent: true,
        });
        phone.put("White.pgn", "garbage");
        await runSync(phone, client(repo), first.manifest, { readOnlyContent: true });
        expect(phone.text("White.pgn")).toBe(PGN);
        expect(repo.text("repertoires/White.pgn")).toBe(PGN);
    });

    test("the PC changed the file meanwhile: the PC's version wins, then the comment is applied on top", async () => {
        const repo = new FakeRepo();
        const pc = new MemoryEnv();
        pc.put("White.pgn", PGN);
        const pcFirst = await runSync(pc, client(repo), emptyManifest("pc"));
        const phone = new MemoryEnv();
        const phoneFirst = await runSync(phone, client(repo), emptyManifest("ph"), {
            readOnlyContent: true,
        });
        // PC adds a variation, phone comments e5: both before syncing.
        pc.put("White.pgn", "1. e4 e5 (1... c5 2. Nf3) 2. Nf3 *");
        await runSync(pc, client(repo), pcFirst.manifest);
        const edit = { game: 0, line: ["e4", "e5"], text: "Simmetrica" };
        phone.put("White.pgn", setMoveComment(PGN, edit.game, edit.line, edit.text)!);
        const writable = () => true;
        const second = await runSync(phone, client(repo), phoneFirst.manifest, {
            readOnlyContent: true,
            writable,
        });
        // Remote wins: nothing of the PC's work is lost.
        expect(phone.text("White.pgn")).toBe("1. e4 e5 (1... c5 2. Nf3) 2. Nf3 *");
        // The phone applies its edit again (mobile/src/comments.ts) and syncs.
        phone.put(
            "White.pgn",
            setMoveComment(phone.text("White.pgn")!, edit.game, edit.line, edit.text)!,
        );
        await runSync(phone, client(repo), second.manifest, { readOnlyContent: true, writable });
        expect(repo.text("repertoires/White.pgn")).toBe(
            "1. e4 e5 {Simmetrica} (1... c5 2. Nf3) 2. Nf3 *",
        );
    });
});

describe("runSync read-only content (mobile)", () => {
    test("never uploads or deletes repertoires, but uploads progress", async () => {
        const repo = new FakeRepo();
        const pc = new MemoryEnv();
        pc.put("White.pgn", "1. e4 *");
        pc.put("Black.pgn", "1. e4 c5 *");
        const pcSync = await runSync(pc, client(repo), emptyManifest("pc"));

        const phone = new MemoryEnv();
        const first = await runSync(phone, client(repo), emptyManifest("phone"), {
            readOnlyContent: true,
        });
        expect(phone.text("White.pgn")).toBe("1. e4 *");

        // Local edits / deletions / extra files on the phone are reverted, not pushed.
        phone.put("White.pgn", "1. d4 *");
        phone.files.delete("Black.pgn");
        phone.put("Extra.pgn", "1. c4 *");
        phone.setDeck("White.pgn", "0", {
            positions: [{ fen: "A", answer: "e4", card: card("2026-10-20T08:00:00Z", 1) }],
            logs: [log("A", "2026-10-20T08:00:00Z")],
        });
        await runSync(phone, client(repo), first.manifest, { readOnlyContent: true });
        expect(phone.text("White.pgn")).toBe("1. e4 *");
        expect(phone.text("Black.pgn")).toBe("1. e4 c5 *");
        expect(phone.text("Extra.pgn")).toBeUndefined();
        expect(repo.text("repertoires/White.pgn")).toBe("1. e4 *");
        expect(repo.text("repertoires/Extra.pgn")).toBeUndefined();
        expect(parseProgress(repo.text("progress/White.json")!)["0"].logs).toHaveLength(1);

        // The PC receives the phone's progress.
        await runSync(pc, client(repo), pcSync.manifest);
        expect(pc.getDecks("White.pgn")["0"].positions[0].card.reps).toBe(1);
    });
});

describe("renames", () => {
    const reviewed = (fen: string, when: string): PracticeData => ({
        positions: [{ fen, answer: "e4", card: card(when, 1) }],
        logs: [log(fen, when)],
    });

    test("renaming on the PC moves progress, also for the phone", async () => {
        const repo = new FakeRepo();
        const pc = new MemoryEnv();
        pc.put("White.pgn", "1. e4 *");
        pc.setDeck("White.pgn", "0", reviewed("A", "2026-10-01T10:00:00Z"));
        const pcFirst = await runSync(pc, client(repo), emptyManifest("pc"));

        const phone = new MemoryEnv();
        const phoneFirst = await runSync(phone, client(repo), emptyManifest("phone"), {
            readOnlyContent: true,
        });
        // The phone reviews another position and syncs before the PC renames.
        const deck = phone.getDecks("White.pgn")["0"];
        deck.positions.push({ fen: "B", answer: "d4", card: card("2026-10-05T10:00:00Z", 1) });
        deck.logs.push(log("B", "2026-10-05T10:00:00Z"));
        phone.setDeck("White.pgn", "0", deck);
        const phoneSecond = await runSync(phone, client(repo), phoneFirst.manifest, {
            readOnlyContent: true,
        });

        // Rename + move into a folder on the PC.
        pc.files.set("Openings/Bianco.pgn", pc.files.get("White.pgn")!);
        pc.files.delete("White.pgn");
        // (decks are still stored under the old name, as after a rename in Explorer)
        const pcSecond = await runSync(pc, client(repo), pcFirst.manifest);
        expect(pcSecond.summary.renamed).toBe(1);
        expect(repo.text("repertoires/White.pgn")).toBeUndefined();
        expect(repo.text("progress/White.json")).toBeUndefined();
        const moved = parseProgress(repo.text("progress/Openings/Bianco.json")!)["0"];
        expect(moved.logs.map((l) => l.fen).sort()).toEqual(["A", "B"]);
        expect(pc.getDecks("Openings/Bianco.pgn")["0"].logs).toHaveLength(2);
        expect(pc.getDecks("White.pgn")).toEqual({});

        // The phone follows the rename without losing its decks.
        const phoneThird = await runSync(phone, client(repo), phoneSecond.manifest, {
            readOnlyContent: true,
        });
        expect(phoneThird.summary.renamed).toBe(1);
        expect(phone.text("White.pgn")).toBeUndefined();
        expect(phone.text("Openings/Bianco.pgn")).toBe("1. e4 *");
        expect(phone.getDecks("Openings/Bianco.pgn")["0"].logs).toHaveLength(2);
        expect(phone.getDecks("White.pgn")).toEqual({});
    });

    test("a renamed and edited file is not treated as a rename", async () => {
        const repo = new FakeRepo();
        const pc = new MemoryEnv();
        pc.put("White.pgn", "1. e4 *");
        const first = await runSync(pc, client(repo), emptyManifest("pc"));
        pc.files.delete("White.pgn");
        pc.put("Bianco.pgn", "1. e4 e5 *");
        const second = await runSync(pc, client(repo), first.manifest);
        expect(second.summary.renamed).toBe(0);
        expect(repo.text("repertoires/Bianco.pgn")).toBe("1. e4 e5 *");
    });

    test("two files with the same content are paired one to one", async () => {
        const repo = new FakeRepo();
        const pc = new MemoryEnv();
        pc.put("A.pgn", "1. e4 *");
        pc.put("B.pgn", "1. e4 *");
        pc.setDeck("A.pgn", "0", reviewed("A", "2026-10-01T10:00:00Z"));
        pc.setDeck("B.pgn", "0", reviewed("B", "2026-10-01T10:00:00Z"));
        const first = await runSync(pc, client(repo), emptyManifest("pc"));
        pc.files.set("C.pgn", pc.files.get("A.pgn")!);
        pc.files.set("D.pgn", pc.files.get("B.pgn")!);
        pc.files.delete("A.pgn");
        pc.files.delete("B.pgn");
        const second = await runSync(pc, client(repo), first.manifest);
        expect(second.summary.renamed).toBe(2);
        const fens = ["C", "D"].map((n) => pc.getDecks(`${n}.pgn`)["0"].positions[0].fen).sort();
        expect(fens).toEqual(["A", "B"]);
    });
});

describe("pause", () => {
    test("a pause set on the phone reaches the PC, the latest change wins", async () => {
        const repo = new FakeRepo();
        const pc = new MemoryEnv();
        pc.put("Scotch.pgn", "1. e4 e5 2. Nf3 Nc6 3. d4 *");
        const pcFirst = await runSync(pc, client(repo), emptyManifest("pc"));

        const phone = new MemoryEnv();
        const phoneFirst = await runSync(phone, client(repo), emptyManifest("phone"), {
            readOnlyContent: true,
        });
        // Paused on the phone, even though the repertoire was never practiced.
        phone.setPause("Scotch.pgn", { paused: true, changedAt: "2026-11-02T10:00:00Z" });
        const phoneSecond = await runSync(phone, client(repo), phoneFirst.manifest, {
            readOnlyContent: true,
        });
        expect(parseProgressFile(repo.text("progress/Scotch.json")!).pause?.paused).toBe(true);

        const pcSecond = await runSync(pc, client(repo), pcFirst.manifest);
        expect(pc.getPause("Scotch.pgn")?.paused).toBe(true);

        // Resumed on the PC later: the phone follows.
        pc.setPause("Scotch.pgn", { paused: false, changedAt: "2026-11-05T10:00:00Z" });
        await runSync(pc, client(repo), pcSecond.manifest);
        await runSync(phone, client(repo), phoneSecond.manifest, { readOnlyContent: true });
        expect(phone.getPause("Scotch.pgn")?.paused).toBe(false);
    });

    test("an older remote change does not override a newer local one", async () => {
        const repo = new FakeRepo();
        const pc = new MemoryEnv();
        pc.put("Scotch.pgn", "1. e4 *");
        const first = await runSync(pc, client(repo), emptyManifest("pc"));
        await repo.commitFiles({
            "progress/Scotch.json": serializeProgress(
                {},
                { paused: true, changedAt: "2026-11-01T00:00:00Z" },
            ),
        });
        pc.setPause("Scotch.pgn", { paused: false, changedAt: "2026-11-02T00:00:00Z" });
        await runSync(pc, client(repo), first.manifest);
        expect(pc.getPause("Scotch.pgn")?.paused).toBe(false);
        expect(parseProgressFile(repo.text("progress/Scotch.json")!).pause?.paused).toBe(false);
    });

    test("the pause follows a renamed repertoire", async () => {
        const repo = new FakeRepo();
        const pc = new MemoryEnv();
        pc.put("Scotch.pgn", "1. e4 *");
        pc.setPause("Scotch.pgn", { paused: true, changedAt: "2026-11-02T00:00:00Z" });
        const first = await runSync(pc, client(repo), emptyManifest("pc"));
        pc.files.set("Scozzese.pgn", pc.files.get("Scotch.pgn")!);
        pc.files.delete("Scotch.pgn");
        await runSync(pc, client(repo), first.manifest);
        expect(pc.getPause("Scozzese.pgn")?.paused).toBe(true);
        expect(parseProgressFile(repo.text("progress/Scozzese.json")!).pause?.paused).toBe(true);
    });
});

describe("flags to review", () => {
    test("a flag made on the phone reaches the PC; resolved on the PC it closes on the phone", async () => {
        const repo = new FakeRepo();
        const pc = new MemoryEnv();
        pc.put("Philidor.pgn", "1. e4 e5 2. Nf3 d6 3. d4 *");
        const pcFirst = await runSync(pc, client(repo), emptyManifest("pc"));
        const phone = new MemoryEnv();
        const phoneFirst = await runSync(phone, client(repo), emptyManifest("phone"), {
            readOnlyContent: true,
        });

        const line = ["e4", "e5", "Nf3", "d6", "d4"];
        phone.setFlags("Philidor.pgn", setFlag([], 0, line, "Meglio Dd2?", "Android"));
        const phoneSecond = await runSync(phone, client(repo), phoneFirst.manifest, {
            readOnlyContent: true,
        });
        expect(parseProgressFile(repo.text("progress/Philidor.json")!).flags).toHaveLength(1);

        const pcSecond = await runSync(pc, client(repo), pcFirst.manifest);
        const onPc = flagAt(pc.getFlags("Philidor.pgn"), 0, line);
        expect(onPc?.text).toBe("Meglio Dd2?");
        expect(onPc?.device).toBe("Android");

        // Meanwhile the phone flags another move; the PC resolves the first one.
        phone.setFlags(
            "Philidor.pgn",
            setFlag(phone.getFlags("Philidor.pgn"), 0, ["e4"], "Ok?", "Android"),
        );
        pc.setFlags("Philidor.pgn", resolveFlag(pc.getFlags("Philidor.pgn"), onPc!.id));
        await runSync(pc, client(repo), pcSecond.manifest);
        await runSync(phone, client(repo), phoneSecond.manifest, { readOnlyContent: true });
        const final = phone.getFlags("Philidor.pgn");
        expect(flagAt(final, 0, line)).toBeUndefined();
        expect(flagAt(final, 0, ["e4"])?.text).toBe("Ok?");
        expect(final.find((f) => f.id === onPc!.id)?.resolvedAt).toBeDefined();
    });

    test("flags follow a renamed repertoire", async () => {
        const repo = new FakeRepo();
        const pc = new MemoryEnv();
        pc.put("Scotch.pgn", "1. e4 *");
        pc.setFlags("Scotch.pgn", setFlag([], 0, ["e4"], "Rivedere", "PC"));
        const first = await runSync(pc, client(repo), emptyManifest("pc"));
        pc.files.set("Scozzese.pgn", pc.files.get("Scotch.pgn")!);
        pc.files.delete("Scotch.pgn");
        await runSync(pc, client(repo), first.manifest);
        expect(flagAt(pc.getFlags("Scozzese.pgn"), 0, ["e4"])?.text).toBe("Rivedere");
        expect(parseProgressFile(repo.text("progress/Scozzese.json")!).flags).toHaveLength(1);
    });
});

describe("GitHubClient", () => {
    test("sends auth headers and maps errors", async () => {
        const calls: { url: string; init?: RequestInit }[] = [];
        const fakeFetch = async (url: string, init?: RequestInit) => {
            calls.push({ url, init });
            if (url.endsWith("/git/ref/heads/main")) {
                return new Response(JSON.stringify({ message: "Git Repository is empty." }), {
                    status: 409,
                });
            }
            return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
        };
        const c = new GitHubClient("tok", { owner: "me", repo: "rep", branch: "main" }, fakeFetch);
        expect(await c.getHead()).toBeNull();
        expect((calls[0].init!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
        await expect(c.getRepo()).rejects.toMatchObject({
            status: 401,
            message: "401 Bad credentials",
        });
    });
});
