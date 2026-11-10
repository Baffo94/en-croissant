// Repertoire check: holes (frequent opponent moves not prepared), dubious moves of
// the repertoire side (Stockfish) and inconsistencies (the same position with
// different answers, also across sections and files of the same colour).
//
// Pure logic: Lichess explorer and engine are passed in, so it can be tested.

import { parseUci } from "chessops";
import { makeFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import { positionFromFen } from "./chessops";
import { type PgnGame, parsePgnGames } from "./pgnTree";
import type { TreeNode } from "./treeReducer";

export type CheckSettings = {
    /** Lichess rating buckets of the games used for holes. */
    ratings: number[];
    /** Lichess speeds of the games used for holes. */
    speeds: string[];
    /** Share of the games (0-1) from which an unprepared opponent move is a hole. */
    holeShare: number;
    /** Positions with fewer games than this are not judged (too few to be meaningful). */
    minGames: number;
    /** Engine time per position, in milliseconds (0 = no engine check). */
    engineMs: number;
    /** Loss (centipawns) from which a repertoire move is dubious. */
    lossCp: number;
};

export const DEFAULT_CHECK_SETTINGS: CheckSettings = {
    ratings: [1600, 1800, 2000],
    speeds: ["rapid", "classical"],
    holeShare: 0.1,
    minGames: 50,
    engineMs: 4000,
    lossCp: 70,
};

export type Issue =
    | (IssueBase & {
          kind: "hole";
          /** Opponent move not prepared, its share of the games and their number. */
          move: string;
          share: number;
          games: number;
      })
    | (IssueBase & {
          kind: "dubious";
          move: string;
          best: string;
          /** Centipawns lost by `move` compared with `best`, for the repertoire side. */
          loss: number;
          /** Evaluations (centipawns, White's point of view) of `best` and `move`. */
          bestScore: number;
          moveScore: number;
      })
    | (IssueBase & {
          kind: "inconsistent";
          move: string;
          /** The other answers to the same position, and where they are. */
          others: { label: string; move: string; line: string[] }[];
      });

type IssueBase = {
    /** Stable id: the same problem keeps it from one check to the next. */
    id: string;
    game: number;
    startFen: string;
    /** SAN moves from the start to the position concerned. */
    line: string[];
    fen: string;
};

export type RepertoireText = {
    path: string;
    label: string;
    text: string;
    /**
     * Group (folder) of the file: answers are compared only inside a group, since
     * different repertoires can answer the same position differently on purpose
     * (1.e4 c6 and 1.e4 c5). Defaults to the file itself.
     */
    group?: string;
};

export type ExplorerMove = {
    uci: string;
    san: string;
    white: number;
    black: number;
    draws: number;
};
export type ExplorerData = { white: number; black: number; draws: number; moves: ExplorerMove[] };

/** Evaluation of the best lines of a position: centipawns from White's point of view. */
export type EngineLine = { uci: string; san: string; score: number };

export type CheckDeps = {
    explore: (fen: string) => Promise<ExplorerData>;
    analyse: (fen: string) => Promise<EngineLine[]>;
};

export type CheckProgress = { done: number; total: number; label: string };

/** Position key without move counters: transpositions meet here. */
export function fenKey(fen: string): string {
    return fen.split(" ").slice(0, 4).join(" ");
}

type Visit = {
    node: TreeNode;
    line: string[];
    mine: boolean;
};

function visit(game: PgnGame, fn: (v: Visit) => void) {
    const me = game.orientation === "white" ? "w" : "b";
    const walk = (node: TreeNode, line: string[]) => {
        const turn = node.fen.split(" ")[1];
        fn({ node, line, mine: turn === me });
        for (const child of node.children) walk(child, [...line, child.san ?? ""]);
    };
    walk(game.root, []);
}

type Parsed = { file: RepertoireText; games: PgnGame[] };

type IndexEntry = {
    path: string;
    group: string;
    label: string;
    game: number;
    line: string[];
    /** First child: the practised answer, when it is the repertoire side's move. */
    answer: string | null;
};

/** Every position of every repertoire of one colour (for transpositions and answers). */
function buildIndex(parsed: Parsed[], orientation: "white" | "black") {
    const index = new Map<string, IndexEntry[]>();
    for (const { file, games } of parsed) {
        games.forEach((game, g) => {
            if (game.orientation !== orientation) return;
            visit(game, ({ node, line, mine }) => {
                const key = fenKey(node.fen);
                const list = index.get(key) ?? [];
                list.push({
                    path: file.path,
                    group: file.group ?? file.path,
                    label: file.label,
                    game: g,
                    line,
                    answer: mine && node.children[0] ? (node.children[0].san ?? null) : null,
                });
                index.set(key, list);
            });
        });
    }
    return index;
}

function play(fen: string, uci: string): { fen: string; san: string } | null {
    const [pos, error] = positionFromFen(fen);
    const move = parseUci(uci);
    if (error || !pos || !move) return null;
    const san = makeSan(pos, move);
    pos.play(move);
    return { fen: makeFen(pos.toSetup()), san };
}

/**
 * Checks the repertoires in `scope` (paths); `all` are every repertoire file, used to
 * recognise transpositions and inconsistent answers across files.
 */
export async function checkRepertoires(
    all: RepertoireText[],
    scope: string[],
    settings: CheckSettings,
    deps: CheckDeps,
    options: {
        onProgress?: (p: CheckProgress) => void;
        /** Called with the issues of each file as soon as it is done. */
        onFile?: (path: string, issues: Issue[]) => void;
        cancelled?: () => boolean;
    } = {},
): Promise<Record<string, Issue[]>> {
    const parsed: Parsed[] = all.map((file) => ({ file, games: safeParse(file.text) }));
    const indexes = {
        white: buildIndex(parsed, "white"),
        black: buildIndex(parsed, "black"),
    };
    const targets = parsed.filter((p) => scope.includes(p.file.path));

    // Work list, to report progress over everything.
    type Job = { kind: "hole" | "engine"; fen: string };
    const jobsOf = (p: Parsed) => {
        const jobs: Job[] = [];
        const seen = new Set<string>();
        p.games.forEach((game) =>
            visit(game, ({ node, mine }) => {
                if (node.children.length === 0) return; // end of the line: not judged
                const key = `${mine ? "e" : "h"}|${fenKey(node.fen)}`;
                if (seen.has(key)) return;
                seen.add(key);
                if (!mine) jobs.push({ kind: "hole", fen: node.fen });
                else if (settings.engineMs > 0) jobs.push({ kind: "engine", fen: node.fen });
            }),
        );
        return jobs;
    };
    const total = targets.reduce((n, p) => n + jobsOf(p).length, 0);
    let done = 0;
    const tick = (label: string) => options.onProgress?.({ done, total, label });

    const explored = new Map<string, ExplorerData>();
    const analysed = new Map<string, EngineLine[]>();
    const explore = async (fen: string) => {
        const key = fenKey(fen);
        if (!explored.has(key)) explored.set(key, await deps.explore(fen));
        return explored.get(key)!;
    };
    const analyse = async (fen: string) => {
        const key = fenKey(fen);
        if (!analysed.has(key)) analysed.set(key, await deps.analyse(fen));
        return analysed.get(key)!;
    };

    const result: Record<string, Issue[]> = {};
    for (const { file, games } of targets) {
        const issues: Issue[] = [];
        const seen = new Set<string>();
        tick(file.label);
        for (const [g, game] of games.entries()) {
            const index = indexes[game.orientation];
            const nodes: Visit[] = [];
            visit(game, (v) => nodes.push(v));
            for (const { node, line, mine } of nodes) {
                if (options.cancelled?.()) throw new CheckCancelled();
                if (node.children.length === 0) continue;
                const key = fenKey(node.fen);
                const base = { game: g, startFen: game.root.fen, line, fen: node.fen };

                if (mine) {
                    const answer = node.children[0].san ?? "";
                    // Inconsistencies: other answers to the same position.
                    const group = file.group ?? file.path;
                    const others = (index.get(key) ?? []).filter(
                        (e) => e.group === group && e.answer && e.answer !== answer,
                    );
                    if (others.length > 0 && !seen.has(`i|${key}`)) {
                        seen.add(`i|${key}`);
                        issues.push({
                            ...base,
                            kind: "inconsistent",
                            id: `inconsistent|${key}|${answer}`,
                            move: answer,
                            others: dedupeOthers(others),
                        });
                    }
                    if (settings.engineMs <= 0 || seen.has(`e|${key}`)) continue;
                    seen.add(`e|${key}`);
                    const dubious = await judgeMove(node, game.orientation, settings, analyse);
                    done++;
                    tick(file.label);
                    if (dubious)
                        issues.push({ ...base, ...dubious, id: `dubious|${key}|${answer}` });
                } else {
                    if (seen.has(`h|${key}`)) continue;
                    seen.add(`h|${key}`);
                    const data = await explore(node.fen);
                    done++;
                    tick(file.label);
                    const games = data.white + data.black + data.draws;
                    if (games < settings.minGames) continue;
                    const prepared = new Set(node.children.map((c) => c.san));
                    for (const m of data.moves) {
                        const count = m.white + m.black + m.draws;
                        const share = count / games;
                        if (share < settings.holeShare) continue;
                        const after = play(node.fen, m.uci);
                        if (!after || prepared.has(after.san)) continue;
                        // Reached by another move order somewhere in the repertoires.
                        if (index.has(fenKey(after.fen))) continue;
                        issues.push({
                            ...base,
                            kind: "hole",
                            id: `hole|${key}|${after.san}`,
                            move: after.san,
                            share,
                            games: count,
                        });
                    }
                }
            }
        }
        result[file.path] = issues;
        options.onFile?.(file.path, issues);
    }
    tick("");
    return result;
}

export class CheckCancelled extends Error {
    constructor() {
        super("Check cancelled");
    }
}

function safeParse(text: string): PgnGame[] {
    try {
        return parsePgnGames(text);
    } catch {
        return [];
    }
}

function dedupeOthers(entries: IndexEntry[]) {
    const out: { label: string; move: string; line: string[] }[] = [];
    for (const e of entries) {
        if (out.some((o) => o.label === e.label && o.move === e.answer)) continue;
        out.push({ label: e.label, move: e.answer ?? "", line: e.line });
    }
    return out;
}

/**
 * Compares the repertoire move with the engine's best: from the best lines of the
 * position (the move is often among them), otherwise from the position after it.
 */
async function judgeMove(
    node: TreeNode,
    orientation: "white" | "black",
    settings: CheckSettings,
    analyse: (fen: string) => Promise<EngineLine[]>,
): Promise<Omit<Extract<Issue, { kind: "dubious" }>, keyof IssueBase> | null> {
    const child = node.children[0];
    const lines = await analyse(node.fen);
    if (lines.length === 0) return null;
    const best = lines[0];
    // Compared by SAN: UCI spells castling differently in chessops and in engines.
    const mySan = child.san ?? "";
    let mine = lines.find((l) => l.san === mySan)?.score;
    if (mine === undefined) {
        const after = await analyse(child.fen);
        if (after.length === 0) return null; // mate or stalemate after the move
        mine = after[0].score;
    }
    const sign = orientation === "white" ? 1 : -1;
    const loss = (best.score - mine) * sign;
    if (loss < settings.lossCp || best.san === mySan) return null;
    return {
        kind: "dubious",
        move: child.san ?? "",
        best: best.san,
        loss,
        bestScore: best.score,
        moveScore: mine,
    };
}

/** Centipawns from an engine score (mate = ±100000 minus the distance). */
export function scoreToCp(score: { type: "cp" | "mate"; value: number }): number {
    if (score.type === "cp") return score.value;
    if (score.value === 0) return 0;
    return score.value > 0 ? 100000 - score.value : -100000 - score.value;
}

/** "12. Nf3 Nc6 13. Bb5" — SAN moves with move numbers, starting from `startFen`. */
export function formatLine(startFen: string, line: readonly string[]): string {
    const [, turn, , , , fullText] = startFen.split(" ");
    let full = Number(fullText) || 1;
    let white = turn !== "b";
    const parts: string[] = [];
    line.forEach((san, i) => {
        if (white) parts.push(`${full}.`);
        else if (i === 0) parts.push(`${full}...`);
        parts.push(san);
        if (!white) full++;
        white = !white;
    });
    return parts.join(" ");
}

/** "13. Bb5" or "12... Nc6": the move played from the position after `line`. */
export function formatNextMove(startFen: string, line: readonly string[], san: string): string {
    const all = formatLine(startFen, [...line, san]).split(" ");
    const last = all.slice(-2);
    return /\.$/.test(last[0]) ? last.join(" ") : `${moveNumberBefore(startFen, line)}... ${san}`;
}

function moveNumberBefore(startFen: string, line: readonly string[]): number {
    const [, turn, , , , fullText] = startFen.split(" ");
    const start = Number(fullText) || 1;
    const plies = line.length + (turn === "b" ? 1 : 0);
    return start + Math.floor(plies / 2);
}
