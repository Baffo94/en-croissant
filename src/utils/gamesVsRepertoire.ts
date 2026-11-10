// Your games against your repertoire: where you left the preparation by mistake,
// where the opponent played a move you have not prepared, and how each section goes.
// Positions are compared by FEN, so transpositions are recognised.

import { INITIAL_FEN, makeFen } from "chessops/fen";
import { parsePgn } from "chessops/pgn";
import { makeSan, parseSan } from "chessops/san";
import { positionFromFen } from "./chessops";
import { type PgnGame, parsePgnGames } from "./pgnTree";
import { fenKey, type RepertoireText } from "./repertoireCheck";
import type { TreeNode } from "./treeReducer";

/** A game of one of your accounts, reduced to what the comparison needs. */
export type StoredGame = {
    id: string;
    source: "chesscom" | "lichess";
    account: string;
    url: string;
    /** End (Chess.com) or start (Lichess) of the game, ms. */
    date: number;
    speed: string;
    myColor: "white" | "black";
    opponent: string;
    /** From your point of view. */
    result: "win" | "loss" | "draw";
    /** SAN moves from the standard start (opening only). */
    moves: string[];
};

/** Plies of each game kept: far beyond any opening preparation. */
export const MAX_PLIES = 60;

/** SAN moves of the main line of a PGN game (null for variants or set-up positions). */
export function movesOfPgn(pgn: string): string[] | null {
    const game = parsePgn(pgn)[0];
    if (!game) return null;
    const fen = game.headers.get("FEN");
    if (fen && fen.trim() !== INITIAL_FEN) return null;
    const variant = game.headers.get("Variant");
    if (variant && !/^standard$/i.test(variant)) return null;
    return normaliseMoves([...game.moves.mainline()].map((m) => m.san));
}

/** Replays SAN moves (any spelling) and returns them as the repertoire parser writes them. */
export function normaliseMoves(sans: string[]): string[] {
    const [pos] = positionFromFen(INITIAL_FEN);
    if (!pos) return [];
    const out: string[] = [];
    for (const token of sans.slice(0, MAX_PLIES)) {
        const move = parseSan(pos, token);
        if (!move) break;
        out.push(makeSan(pos, move));
        pos.play(move);
    }
    return out;
}

type Entry = {
    path: string;
    label: string;
    game: number;
    startFen: string;
    line: string[];
    /** Moves of the PGN from this position (the first one is the practised answer). */
    children: string[];
};

function buildIndex(
    repertoires: { file: RepertoireText; games: PgnGame[] }[],
    color: "white" | "black",
) {
    const index = new Map<string, Entry[]>();
    for (const { file, games } of repertoires) {
        games.forEach((game, g) => {
            if (game.orientation !== color) return;
            const walk = (node: TreeNode, line: string[]) => {
                const key = fenKey(node.fen);
                const list = index.get(key) ?? [];
                list.push({
                    path: file.path,
                    label: file.label,
                    game: g,
                    startFen: game.root.fen,
                    line,
                    children: node.children.map((c) => c.san ?? ""),
                });
                index.set(key, list);
                for (const c of node.children) walk(c, [...line, c.san ?? ""]);
            };
            walk(game.root, []);
        });
    }
    return index;
}

export type GameOutcome = {
    game: StoredGame;
    /**
     * deviation: you played another move in a prepared position; hole: the opponent
     * played a move you have not prepared; end: the game went past your preparation;
     * none: the game never entered a repertoire of that colour.
     */
    status: "deviation" | "hole" | "end" | "none";
    /** Plies played inside the preparation. */
    bookPlies: number;
    /** Repertoire file of the last prepared position (null for "none"). */
    path: string | null;
    label: string | null;
    /** Where it happened: position, the move played and the moves prepared there. */
    entry: Entry | null;
    fen: string | null;
    played: string | null;
    prepared: string[];
};

export type Problem = {
    key: string;
    kind: "deviation" | "hole";
    path: string;
    label: string;
    game: number;
    startFen: string;
    /** Repertoire line to the position (its own move order). */
    line: string[];
    fen: string;
    played: string;
    prepared: string[];
    games: StoredGame[];
};

export type SectionStats = {
    path: string;
    label: string;
    games: number;
    points: number;
    /** Average number of moves (plies / 2) played inside the preparation. */
    averageDepth: number;
};

function preferredEntry(entries: Entry[]): Entry {
    // Several files can contain the position: prefer the one that goes deeper.
    return [...entries].sort((a, b) => b.children.length - a.children.length)[0];
}

export function compareGames(repertoires: RepertoireText[], games: StoredGame[]) {
    const parsed = repertoires.map((file) => ({ file, games: safeParse(file.text) }));
    const indexes = { white: buildIndex(parsed, "white"), black: buildIndex(parsed, "black") };
    const outcomes: GameOutcome[] = [];

    for (const game of games) {
        const index = indexes[game.myColor];
        const [pos] = positionFromFen(INITIAL_FEN);
        let fen = INITIAL_FEN;
        let entries = index.get(fenKey(fen));
        let last: Entry | null = null;
        let outcome: GameOutcome = {
            game,
            status: entries ? "end" : "none",
            bookPlies: 0,
            path: null,
            label: null,
            entry: null,
            fen: null,
            played: null,
            prepared: [],
        };
        if (pos && entries) {
            for (let ply = 0; ply < game.moves.length; ply++) {
                last = preferredEntry(entries!);
                const san = game.moves[ply];
                const mine = (ply % 2 === 0) === (game.myColor === "white");
                const move = parseSan(pos, san);
                if (!move) break;
                pos.play(move);
                const next = makeFen(pos.toSetup());
                const nextEntries = index.get(fenKey(next));
                const prepared = [...new Set(entries!.flatMap((e) => e.children))];
                const here = {
                    path: last.path,
                    label: last.label,
                    entry: last,
                    fen,
                    played: san,
                    prepared,
                };
                if (mine) {
                    // Your move: fine if it is the answer of the repertoire, or one of the
                    // alternatives written in it, and the game stays in the preparation.
                    if (!prepared.includes(san) || !nextEntries) {
                        outcome = {
                            ...outcome,
                            ...here,
                            status: prepared.length ? "deviation" : "end",
                            bookPlies: ply,
                        };
                        break;
                    }
                } else if (!nextEntries) {
                    outcome = {
                        ...outcome,
                        ...here,
                        status: prepared.length ? "hole" : "end",
                        bookPlies: ply,
                    };
                    break;
                }
                fen = next;
                entries = nextEntries;
                outcome = { ...outcome, path: last.path, label: last.label, bookPlies: ply + 1 };
            }
            if (outcome.status === "end" && !outcome.path && last) {
                outcome = { ...outcome, path: last.path, label: last.label };
            }
            // A game shorter than the preparation, or that ended exactly at its end.
            if (outcome.status === "end" && entries) {
                const e = preferredEntry(entries);
                outcome = { ...outcome, path: e.path, label: e.label };
            }
        }
        outcomes.push(outcome);
    }

    // Problems grouped by position and move.
    const problems = new Map<string, Problem>();
    for (const o of outcomes) {
        if ((o.status !== "deviation" && o.status !== "hole") || !o.entry || !o.fen || !o.played)
            continue;
        const key = `${o.status}|${fenKey(o.fen)}|${o.played}`;
        const p = problems.get(key) ?? {
            key,
            kind: o.status,
            path: o.entry.path,
            label: o.entry.label,
            game: o.entry.game,
            startFen: o.entry.startFen,
            line: o.entry.line,
            fen: o.fen,
            played: o.played,
            prepared: o.prepared,
            games: [],
        };
        p.games.push(o.game);
        problems.set(key, p);
    }
    const problemList = [...problems.values()].sort(
        (a, b) =>
            b.games.length - a.games.length ||
            Math.max(...b.games.map((g) => g.date)) - Math.max(...a.games.map((g) => g.date)),
    );

    // Results of each section (file of the last prepared position).
    const sections = new Map<string, SectionStats & { plies: number }>();
    for (const o of outcomes) {
        if (!o.path || !o.label) continue;
        const s = sections.get(o.path) ?? {
            path: o.path,
            label: o.label,
            games: 0,
            points: 0,
            averageDepth: 0,
            plies: 0,
        };
        s.games++;
        s.points += o.game.result === "win" ? 1 : o.game.result === "draw" ? 0.5 : 0;
        s.plies += o.bookPlies;
        sections.set(o.path, s);
    }
    const sectionList: SectionStats[] = [...sections.values()]
        .map(({ plies, ...s }) => ({ ...s, averageDepth: s.games ? plies / s.games / 2 : 0 }))
        .sort((a, b) => b.games - a.games);

    return { outcomes, problems: problemList, sections: sectionList };
}

function safeParse(text: string): PgnGame[] {
    try {
        return parsePgnGames(text);
    } catch {
        return [];
    }
}
