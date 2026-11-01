import { describe, expect, test } from "vitest";
import type { PracticeData } from "@/state/atoms";
import {
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
import { ConcurrentPushError, emptyManifest, runSync, type SyncEnv } from "../sync/engine";
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
            if (e.sha === null) tree.delete(e.path);
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
