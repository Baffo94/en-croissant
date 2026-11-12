// Runs the repertoire check in the background (it survives leaving the page) and keeps
// its results and the issues marked "ignore" on this computer.

import { readTextFile } from "@tauri-apps/plugin-fs";
import { atom, getDefaultStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { commands } from "@/bindings";
import { evalCacheSettings } from "@/utils/evalCache";
import { enginesAtom, repertoireCheckSettingsAtom, sessionsAtom } from "@/state/atoms";
import type { LocalEngine } from "@/utils/engines";
import { getLichessGames } from "@/utils/lichess/api";
import type { LichessGameSpeed, LichessRating } from "@/utils/lichess/explorer";
import {
    CheckCancelled,
    checkRepertoires,
    DEFAULT_CHECK_SETTINGS,
    type EngineLine,
    type ExplorerData,
    type Issue,
    scoreToCp,
} from "@/utils/repertoireCheck";
import { normalizePath } from "@/utils/sync/core";

export type CheckFile = { path: string; label: string; group: string };

export type FileResult = { checkedAt: string; issues: Issue[] };

/** Results of the last check of each repertoire (normalised path -> result). */
export const checkResultsAtom = atomWithStorage<Record<string, FileResult>>(
    "repertoire-check-results",
    {},
    undefined,
    { getOnInit: true },
);

/** Issues marked "ignore": "<normalised path>|<issue id>" (this computer only). */
export const checkIgnoredAtom = atomWithStorage<string[]>(
    "repertoire-check-ignored",
    [],
    undefined,
    {
        getOnInit: true,
    },
);

export type CheckRun = {
    running: boolean;
    label: string;
    current: string;
    done: number;
    total: number;
    startedAt: number;
    error: string | null;
};

export const checkRunAtom = atom<CheckRun>({
    running: false,
    label: "",
    current: "",
    done: 0,
    total: 0,
    startedAt: 0,
    error: null,
});

export const ignoreKey = (path: string, issue: Issue) => `${normalizePath(path)}|${issue.id}`;

let cancelled = false;
let currentAnalysis: string | null = null;

export function stopCheck() {
    cancelled = true;
    if (currentAnalysis) commands.cancelAnalysis(currentAnalysis).catch(() => {});
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The engine of the game report (or the first one); the list loads asynchronously. */
export async function pickEngine(): Promise<LocalEngine | null> {
    const store = getDefaultStore();
    // The engine list is read from its file only while someone is subscribed to it.
    const unsubscribe = store.sub(enginesAtom, () => {});
    let all = store.get(enginesAtom) ?? [];
    for (let i = 0; i < 30 && all.length === 0; i++) {
        await sleep(100);
        all = store.get(enginesAtom) ?? [];
    }
    unsubscribe();
    const engines = all.filter((e): e is LocalEngine => e.type === "local");
    let preferred: string | undefined;
    try {
        preferred = JSON.parse(localStorage.getItem("report-settings") ?? "{}").engine;
    } catch {
        // no report settings yet
    }
    return (
        engines.find((e) => e.id === preferred) ??
        engines.find((e) => e.loaded) ??
        engines[0] ??
        null
    );
}

/**
 * Checks the repertoires in `scope`; `all` are every repertoire (for transpositions
 * and for comparing answers inside a group). Throws a readable message when the
 * check cannot start (no engine, no Lichess account).
 */
export async function startCheck(all: CheckFile[], scope: string[], label: string) {
    const store = getDefaultStore();
    if (store.get(checkRunAtom).running) return;
    const engine = await pickEngine();
    // Like the engines, the accounts are read from storage only while subscribed.
    const unsubscribe = store.sub(sessionsAtom, () => {});
    await sleep(50);
    const token = store.get(sessionsAtom).find((s) => s.lichess?.accessToken)?.lichess?.accessToken;
    unsubscribe();
    const settings = { ...DEFAULT_CHECK_SETTINGS, ...store.get(repertoireCheckSettingsAtom) };
    const fail = (error: string) =>
        store.set(checkRunAtom, (r) => ({ ...r, running: false, error }));
    cancelled = false;
    store.set(checkRunAtom, {
        running: true,
        label,
        current: "",
        done: 0,
        total: 0,
        startedAt: Date.now(),
        error: null,
    });
    if (!engine) return fail("NoEngine");
    if (!token) return fail("NoLichess");

    let n = 0;
    const explore = async (fen: string): Promise<ExplorerData> => {
        for (let attempt = 0; ; attempt++) {
            try {
                const data = await getLichessGames(
                    fen,
                    {
                        color: "white",
                        ratings: settings.ratings as LichessRating[],
                        speeds: settings.speeds as LichessGameSpeed[],
                        moves: 20,
                        topGames: 0,
                        recentGames: 0,
                    },
                    token,
                );
                await sleep(150); // gentle with the Lichess servers
                return data;
            } catch (e) {
                // 429: too many requests, wait a minute (as Lichess asks) and retry.
                if (attempt < 3 && String(e).includes("429")) {
                    await sleep(60_000);
                    continue;
                }
                throw e;
            }
        }
    };
    const settingsOfEngine = (engine.settings ?? []).map((s) => ({
        name: s.name,
        value: s.value?.toString() ?? "",
    }));
    const analyse = async (fen: string): Promise<EngineLine[]> => {
        const id = `repertoire_check_${n++}`;
        currentAnalysis = id;
        const result = await commands.analyzeGame(
            id,
            engine.path,
            { t: "Time", c: settings.engineMs },
            {
                fen,
                moves: [],
                annotateNovelties: false,
                referenceDb: null,
                reversed: false,
                evalCache: evalCacheSettings().enabled,
                cloudEval: evalCacheSettings().enabled && evalCacheSettings().cloud,
            },
            settingsOfEngine,
        );
        currentAnalysis = null;
        if (result.status !== "ok") {
            if (cancelled) throw new CheckCancelled();
            throw new Error(result.error);
        }
        return (result.data[0]?.best ?? []).map((b) => ({
            uci: b.uciMoves[0] ?? "",
            san: b.sanMoves[0] ?? "",
            score: scoreToCp(b.score.value as { type: "cp" | "mate"; value: number }),
        }));
    };

    try {
        const texts = await Promise.all(
            all.map(async (f) => ({ ...f, text: await readTextFile(f.path).catch(() => "") })),
        );
        await checkRepertoires(
            texts,
            scope,
            settings,
            { explore, analyse },
            {
                cancelled: () => cancelled,
                onProgress: (p) =>
                    store.set(checkRunAtom, (r) => ({
                        ...r,
                        done: p.done,
                        total: p.total,
                        current: p.label,
                    })),
                onFile: (path, issues) =>
                    store.set(checkResultsAtom, (prev) => ({
                        ...prev,
                        [normalizePath(path)]: { checkedAt: new Date().toISOString(), issues },
                    })),
            },
        );
        store.set(checkRunAtom, (r) => ({ ...r, running: false }));
    } catch (e) {
        if (e instanceof CheckCancelled || cancelled) {
            store.set(checkRunAtom, (r) => ({ ...r, running: false }));
        } else {
            fail(e instanceof Error ? e.message : String(e));
        }
    } finally {
        currentAnalysis = null;
    }
}
