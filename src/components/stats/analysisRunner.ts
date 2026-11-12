// Engine analysis of the games of the Statistics page: in the background, one game
// after the other, saved after each game so that it can be stopped and resumed.

import { appDataDir, resolve } from "@tauri-apps/api/path";
import { exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { atom, getDefaultStore } from "jotai";
import { commands } from "@/bindings";
import { INITIAL_FEN, type StatsGame } from "@/utils/accountStats";
import { evalCacheSettings } from "@/utils/evalCache";
import { type GameEval, gameEvalOf, uciMoves } from "@/utils/gameReview";
import { pickEngine } from "../repertoires/checkRunner";

/** About one second per position, as chosen for the statistics. */
export const MS_PER_MOVE = 1000;
const ANALYSIS_ID = "account_stats";

type EvalsFile = { version: 1; games: Record<string, GameEval> };

export const statsEvalsAtom = atom<Record<string, GameEval> | null>(null);

export type StatsAnalysisRun = {
    running: boolean;
    engine: string;
    done: number;
    total: number;
    pliesDone: number;
    pliesTotal: number;
    startedAt: number;
    failed: number;
    error: string | null;
};

export const statsAnalysisRunAtom = atom<StatsAnalysisRun>({
    running: false,
    engine: "",
    done: 0,
    total: 0,
    pliesDone: 0,
    pliesTotal: 0,
    startedAt: 0,
    failed: 0,
    error: null,
});

async function evalsPath() {
    return resolve(await appDataDir(), "account-stats-analysis.json");
}

export async function loadStatsEvals(): Promise<Record<string, GameEval>> {
    const store = getDefaultStore();
    const cached = store.get(statsEvalsAtom);
    if (cached) return cached;
    let games: Record<string, GameEval> = {};
    try {
        const path = await evalsPath();
        if (await exists(path)) games = (JSON.parse(await readTextFile(path)) as EvalsFile).games;
    } catch {
        // unreadable: start again
    }
    store.set(statsEvalsAtom, games);
    return games;
}

async function saveEvals(games: Record<string, GameEval>) {
    const file: EvalsFile = { version: 1, games };
    await writeTextFile(await evalsPath(), JSON.stringify(file));
}

let cancelled = false;

export function stopStatsAnalysis() {
    cancelled = true;
    commands.cancelAnalysis(ANALYSIS_ID).catch(() => {});
}

const plies = (g: StatsGame) => (g.moves ? g.moves.split(" ").length : 0);

/** Analyses the games not analysed yet, in the given order (newest first is best). */
export async function startStatsAnalysis(games: StatsGame[]) {
    const store = getDefaultStore();
    if (store.get(statsAnalysisRunAtom).running) return;
    const evals = { ...(await loadStatsEvals()) };
    const todo = games.filter((g) => !evals[g.id] && plies(g) >= 2);
    cancelled = false;
    const engine = await pickEngine();
    store.set(statsAnalysisRunAtom, {
        running: true,
        engine: engine?.name ?? "",
        done: 0,
        total: todo.length,
        pliesDone: 0,
        pliesTotal: todo.reduce((s, g) => s + plies(g), 0),
        startedAt: Date.now(),
        failed: 0,
        error: null,
    });
    if (!engine) {
        store.set(statsAnalysisRunAtom, (r) => ({ ...r, running: false, error: "NoEngine" }));
        return;
    }
    const uciOptions = [
        ...(engine.settings ?? [])
            .filter((s) => s.name !== "MultiPV")
            .map((s) => ({ name: s.name, value: s.value?.toString() ?? "" })),
        { name: "MultiPV", value: "1" },
    ];
    let failedInARow = 0;
    for (const game of todo) {
        if (cancelled) break;
        const cache = evalCacheSettings();
        const result = await commands.analyzeGame(
            ANALYSIS_ID,
            engine.path,
            { t: "Time", c: MS_PER_MOVE },
            {
                fen: INITIAL_FEN,
                moves: uciMoves(game),
                annotateNovelties: false,
                referenceDb: null,
                reversed: false,
                evalCache: cache.enabled,
                cloudEval: cache.enabled && cache.cloud,
            },
            uciOptions,
        );
        if (cancelled) break;
        if (result.status !== "ok") {
            failedInARow++;
            store.set(statsAnalysisRunAtom, (r) => ({ ...r, failed: r.failed + 1 }));
            if (failedInARow >= 3) {
                store.set(statsAnalysisRunAtom, (r) => ({
                    ...r,
                    running: false,
                    error: String(result.error),
                }));
                return;
            }
            continue;
        }
        failedInARow = 0;
        evals[game.id] = gameEvalOf(game, result.data);
        store.set(statsEvalsAtom, { ...evals });
        try {
            await saveEvals(evals);
        } catch (e) {
            store.set(statsAnalysisRunAtom, (r) => ({ ...r, running: false, error: String(e) }));
            return;
        }
        store.set(statsAnalysisRunAtom, (r) => ({
            ...r,
            done: r.done + 1,
            pliesDone: r.pliesDone + plies(game),
        }));
    }
    store.set(statsAnalysisRunAtom, (r) => ({ ...r, running: false }));
}

/** Milliseconds still needed, from the speed so far (or one second per move before the first game). */
export function remainingMs(run: StatsAnalysisRun, now: number): number {
    const left = run.pliesTotal - run.pliesDone;
    if (run.pliesDone > 0) return (left * (now - run.startedAt)) / run.pliesDone;
    return left * MS_PER_MOVE;
}
