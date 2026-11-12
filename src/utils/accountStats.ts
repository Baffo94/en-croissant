// Statistics of one account's games: how they are stored (from Chess.com and Lichess)
// and what is computed from them (openings, habits, comparison with the previous period).
// Pure functions: the download and the page live in src/components/stats.

import { parseComment, parsePgn } from "chessops/pgn";
import {
    type EngineStats,
    engineStats,
    type GameEval,
    PHASES,
    seriousRate,
    winChance,
} from "./gameReview";

export type Ending =
    | "mate"
    | "resign"
    | "time"
    | "abandon"
    | "agreement"
    | "repetition"
    | "stalemate"
    | "insufficient"
    | "fifty"
    | "timeVsInsufficient"
    | "draw"
    | "other";

export const ENDINGS: Ending[] = [
    "mate",
    "resign",
    "time",
    "abandon",
    "agreement",
    "repetition",
    "stalemate",
    "insufficient",
    "fifty",
    "timeVsInsufficient",
    "draw",
    "other",
];

export type GameResult = "win" | "draw" | "loss";

export type StatsGame = {
    id: string;
    source: "chesscom" | "lichess";
    url: string;
    /** Start and end of the game (ms). */
    start: number;
    end: number;
    /** bullet, blitz, rapid, classical or correspondence. */
    speed: string;
    /** Seconds + increment, e.g. "600+5" ("" when unknown or daily). */
    timeControl: string;
    rated: boolean;
    color: "white" | "black";
    rating: number | null;
    oppRating: number | null;
    opponent: string;
    result: GameResult;
    ending: Ending;
    /** SAN moves separated by spaces. */
    moves: string;
    /** Clock after each move, in tenths of a second (empty when unknown). */
    clocks: number[];
    /** Opening name from the openings table ("Family: Variation"), null when not found. */
    opening: string | null;
};

// ---------------------------------------------------------------- Chess.com

const CHESSCOM_DRAWS: Record<string, Ending> = {
    agreed: "agreement",
    repetition: "repetition",
    stalemate: "stalemate",
    insufficient: "insufficient",
    "50move": "fifty",
    timevsinsufficient: "timeVsInsufficient",
};

const CHESSCOM_LOSSES: Record<string, Ending> = {
    checkmated: "mate",
    resigned: "resign",
    timeout: "time",
    abandoned: "abandon",
};

export type ChessComApiGame = {
    url: string;
    pgn?: string | null;
    end_time: number;
    rated?: boolean;
    rules: string;
    time_class?: string;
    time_control?: string;
    initial_setup?: string;
    white: { username: string; rating?: number; result: string };
    black: { username: string; rating?: number; result: string };
};

export const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function utcTime(date: string | undefined, time: string | undefined): number | null {
    if (!date || !time) return null;
    const d = date.split(".").map(Number);
    const t = time.split(":").map(Number);
    if (d.length !== 3 || t.length < 2 || [...d, ...t].some((x) => Number.isNaN(x))) return null;
    return Date.UTC(d[0], d[1] - 1, d[2], t[0], t[1], t[2] ?? 0);
}

/** One game of a Chess.com monthly archive, seen from `user`; null when not standard chess. */
export function chessComGame(g: ChessComApiGame, user: string): StatsGame | null {
    if (g.rules !== "chess" || !g.pgn) return null;
    if (g.initial_setup && g.initial_setup !== INITIAL_FEN) return null;
    const game = parsePgn(g.pgn)[0];
    if (!game) return null;
    const fen = game.headers.get("FEN");
    if (fen && fen.trim() !== INITIAL_FEN) return null;
    const moves: string[] = [];
    const clocks: number[] = [];
    for (const node of game.moves.mainline()) {
        moves.push(node.san);
        const clock = (node.comments ?? [])
            .map((c) => parseComment(c).clock)
            .find((c) => c !== undefined);
        if (clock !== undefined) clocks.push(Math.round(clock * 10));
    }
    const white = g.white.username.toLowerCase() === user.toLowerCase();
    const me = white ? g.white : g.black;
    const opp = white ? g.black : g.white;
    const result: GameResult =
        me.result === "win" ? "win" : me.result in CHESSCOM_DRAWS ? "draw" : "loss";
    const ending: Ending =
        result === "draw"
            ? CHESSCOM_DRAWS[me.result]
            : ((result === "win" ? CHESSCOM_LOSSES[opp.result] : CHESSCOM_LOSSES[me.result]) ??
              "other");
    const end = g.end_time * 1000;
    const start =
        utcTime(game.headers.get("UTCDate"), game.headers.get("UTCTime")) ??
        utcTime(game.headers.get("Date"), game.headers.get("StartTime")) ??
        end;
    const daily = g.time_class === "daily";
    return {
        id: g.url,
        source: "chesscom",
        url: g.url,
        start: Math.min(start, end),
        end,
        speed: daily ? "correspondence" : (g.time_class ?? "rapid"),
        timeControl: daily ? "" : (g.time_control ?? ""),
        rated: g.rated ?? true,
        color: white ? "white" : "black",
        rating: me.rating ?? null,
        oppRating: opp.rating ?? null,
        opponent: opp.username,
        result,
        ending,
        moves: moves.join(" "),
        clocks: clocks.length === moves.length ? clocks : [],
        opening: null,
    };
}

// ---------------------------------------------------------------- Lichess

export type LichessApiGame = {
    id: string;
    rated?: boolean;
    variant: string;
    speed: string;
    createdAt: number;
    lastMoveAt?: number;
    status: string;
    initialFen?: string;
    winner?: "white" | "black";
    moves?: string;
    clocks?: number[];
    clock?: { initial: number; increment: number };
    players: {
        white: { user?: { name: string }; rating?: number };
        black: { user?: { name: string }; rating?: number };
    };
};

const LICHESS_ENDINGS: Record<string, Ending> = {
    mate: "mate",
    resign: "resign",
    outoftime: "time",
    timeout: "abandon",
    stalemate: "stalemate",
    draw: "draw",
    insufficientMaterialClaim: "insufficient",
};

const LICHESS_SPEEDS: Record<string, string> = { ultraBullet: "bullet" };

/** One game of the Lichess export (ndjson), seen from `user`; null when not standard chess. */
export function lichessGame(g: LichessApiGame, user: string): StatsGame | null {
    if (g.variant !== "standard" || g.initialFen) return null;
    if (["created", "started", "aborted", "noStart", "unknownFinish"].includes(g.status))
        return null;
    const white = g.players.white.user?.name.toLowerCase() === user.toLowerCase();
    const black = g.players.black.user?.name.toLowerCase() === user.toLowerCase();
    if (!white && !black) return null;
    const me = white ? g.players.white : g.players.black;
    const opp = white ? g.players.black : g.players.white;
    const result: GameResult = !g.winner
        ? "draw"
        : (g.winner === "white") === white
          ? "win"
          : "loss";
    let ending = LICHESS_ENDINGS[g.status] ?? "other";
    if (result === "draw" && g.status === "outoftime") ending = "timeVsInsufficient";
    const moves = (g.moves ?? "").trim();
    const plies = moves ? moves.split(" ").length : 0;
    const clocks = (g.clocks ?? []).map((c) => Math.round(c / 10));
    return {
        id: `lichess:${g.id}`,
        source: "lichess",
        url: `https://lichess.org/${g.id}${white ? "" : "/black"}`,
        start: g.createdAt,
        end: g.lastMoveAt ?? g.createdAt,
        speed: LICHESS_SPEEDS[g.speed] ?? g.speed,
        timeControl: g.clock ? `${g.clock.initial}+${g.clock.increment}` : "",
        rated: g.rated ?? true,
        color: white ? "white" : "black",
        rating: me.rating ?? null,
        oppRating: opp.rating ?? null,
        opponent: opp.user?.name ?? "?",
        result,
        ending,
        moves,
        clocks: clocks.length === plies ? clocks : [],
        opening: null,
    };
}

// ---------------------------------------------------------------- Scores

export type Score = {
    n: number;
    wins: number;
    draws: number;
    losses: number;
    /** Points per game, 0..1 (0 when n = 0). */
    score: number;
    /** Expected points per game from the ratings (null when no game had both ratings). */
    expected: number | null;
};

export function expectedScore(g: StatsGame): number | null {
    if (g.rating == null || g.oppRating == null) return null;
    return 1 / (1 + 10 ** ((g.oppRating - g.rating) / 400));
}

export function scoreOf(games: StatsGame[]): Score {
    let wins = 0;
    let draws = 0;
    let expSum = 0;
    let expN = 0;
    for (const g of games) {
        if (g.result === "win") wins++;
        else if (g.result === "draw") draws++;
        const e = expectedScore(g);
        if (e !== null) {
            expSum += e;
            expN++;
        }
    }
    const n = games.length;
    return {
        n,
        wins,
        draws,
        losses: n - wins - draws,
        score: n ? (wins + draws / 2) / n : 0,
        expected: expN ? expSum / expN : null,
    };
}

/** Points above (positive) or below the expectation, per game (-1..1). */
export function performance(s: Score): number {
    return s.score - (s.expected ?? 0.5);
}

// ---------------------------------------------------------------- Selection

export type StatsFilter = {
    speed: string;
    ratedOnly: boolean;
    /** Length of the period in days (the previous period has the same length). */
    days: number;
};

const DAY = 24 * 3600 * 1000;

export function periods(now: number, days: number) {
    return {
        current: { from: now - days * DAY, to: now },
        previous: { from: now - 2 * days * DAY, to: now - days * DAY },
    };
}

/** Games of the chosen speed (and rated, if asked) ended in [from, to). */
export function selectGames(
    games: StatsGame[],
    filter: StatsFilter,
    range: { from: number; to: number },
): StatsGame[] {
    return games
        .filter(
            (g) =>
                g.speed === filter.speed &&
                (!filter.ratedOnly || g.rated) &&
                g.end >= range.from &&
                g.end < range.to,
        )
        .sort((a, b) => a.end - b.end);
}

// ---------------------------------------------------------------- Sessions

/** Games closer than this belong to the same session. */
export const SESSION_GAP = 30 * 60 * 1000;

export type SessionInfo = {
    /** 1 for the first game of a session. */
    index: number;
    /** Result of the game played just before in the same session (null for the first). */
    previous: GameResult | null;
    /** Losses in a row just before this game, in the same session. */
    lossStreak: number;
};

/** Session position of every game, computed over all the account's games (any speed). */
export function sessions(all: StatsGame[]): Map<string, SessionInfo> {
    const sorted = [...all].sort((a, b) => a.start - b.start);
    const out = new Map<string, SessionInfo>();
    let last: StatsGame | null = null;
    let index = 0;
    let streak = 0;
    for (const g of sorted) {
        if (!last || g.start - last.end > SESSION_GAP) {
            index = 1;
            streak = 0;
            out.set(g.id, { index, previous: null, lossStreak: 0 });
        } else {
            index++;
            streak = last.result === "loss" ? streak + 1 : 0;
            out.set(g.id, { index, previous: last.result, lossStreak: streak });
        }
        if (!last || g.end >= last.end) last = g;
    }
    return out;
}

// ---------------------------------------------------------------- Openings

export const UNKNOWN_OPENING = "?";

export function openingFamily(name: string | null): string {
    if (!name) return UNKNOWN_OPENING;
    return name.split(":")[0].trim();
}

export type OpeningRow = {
    color: "white" | "black";
    family: string;
    score: Score;
    variations: { name: string; score: Score }[];
};

export function openingRows(games: StatsGame[]): OpeningRow[] {
    const groups = new Map<string, StatsGame[]>();
    for (const g of games) {
        const key = `${g.color}|${openingFamily(g.opening)}`;
        const list = groups.get(key);
        if (list) list.push(g);
        else groups.set(key, [g]);
    }
    const rows: OpeningRow[] = [];
    for (const [key, list] of groups) {
        const [color, family] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
        const byName = new Map<string, StatsGame[]>();
        for (const g of list) {
            const name = g.opening ?? UNKNOWN_OPENING;
            const l = byName.get(name);
            if (l) l.push(g);
            else byName.set(name, [g]);
        }
        rows.push({
            color: color as "white" | "black",
            family,
            score: scoreOf(list),
            variations: [...byName]
                .map(([name, l]) => ({ name, score: scoreOf(l) }))
                .sort((a, b) => b.score.n - a.score.n || a.name.localeCompare(b.name)),
        });
    }
    return rows.sort((a, b) => b.score.n - a.score.n || a.family.localeCompare(b.family));
}

// ---------------------------------------------------------------- Habits

export const SESSION_BUCKETS = ["1", "2", "3", "4-5", "6+"] as const;
export const OPPONENT_BUCKETS = [
    "muchWeaker",
    "weaker",
    "equal",
    "stronger",
    "muchStronger",
] as const;

function sessionBucket(index: number): (typeof SESSION_BUCKETS)[number] {
    if (index <= 3) return String(index) as "1" | "2" | "3";
    return index <= 5 ? "4-5" : "6+";
}

/** Bucket of the rating difference (opponent minus you). */
export function opponentBucket(g: StatsGame): (typeof OPPONENT_BUCKETS)[number] | null {
    if (g.rating == null || g.oppRating == null) return null;
    const d = g.oppRating - g.rating;
    if (d < -150) return "muchWeaker";
    if (d < -50) return "weaker";
    if (d <= 50) return "equal";
    if (d <= 150) return "stronger";
    return "muchStronger";
}

export type Habits = {
    after: { first: Score; win: Score; draw: Score; loss: Score; lossStreak: Score };
    session: Record<(typeof SESSION_BUCKETS)[number], Score>;
    opponents: Record<(typeof OPPONENT_BUCKETS)[number], Score>;
    endings: Record<GameResult, Partial<Record<Ending, number>>>;
};

export function habits(games: StatsGame[], info: Map<string, SessionInfo>): Habits {
    const pick = (f: (g: StatsGame, s: SessionInfo) => boolean) =>
        scoreOf(
            games.filter((g) => {
                const s = info.get(g.id);
                return s ? f(g, s) : false;
            }),
        );
    const session = Object.fromEntries(
        SESSION_BUCKETS.map((b) => [b, pick((_, s) => sessionBucket(s.index) === b)]),
    ) as Habits["session"];
    const opponents = Object.fromEntries(
        OPPONENT_BUCKETS.map((b) => [b, scoreOf(games.filter((g) => opponentBucket(g) === b))]),
    ) as Habits["opponents"];
    const endings: Habits["endings"] = { win: {}, draw: {}, loss: {} };
    for (const g of games) {
        const e = endings[g.result];
        e[g.ending] = (e[g.ending] ?? 0) + 1;
    }
    return {
        after: {
            first: pick((_, s) => s.previous === null),
            win: pick((_, s) => s.previous === "win"),
            draw: pick((_, s) => s.previous === "draw"),
            loss: pick((_, s) => s.previous === "loss"),
            lossStreak: pick((_, s) => s.lossStreak >= 2),
        },
        session,
        opponents,
        endings,
    };
}

// ---------------------------------------------------------------- Report

export type RatingPoint = { date: number; rating: number };

export type PeriodStats = {
    games: StatsGame[];
    total: Score;
    white: Score;
    black: Score;
    ratingFrom: number | null;
    ratingTo: number | null;
    avgOpponent: number | null;
    ratings: RatingPoint[];
    openings: OpeningRow[];
    habits: Habits;
    /** What the engine says (only the analysed games count); null without analyses. */
    engine: EngineStats | null;
};

function periodStats(
    games: StatsGame[],
    info: Map<string, SessionInfo>,
    evals?: Record<string, GameEval>,
): PeriodStats {
    const rated = games.filter((g) => g.rating != null);
    const opp = games.filter((g) => g.oppRating != null);
    return {
        games,
        total: scoreOf(games),
        white: scoreOf(games.filter((g) => g.color === "white")),
        black: scoreOf(games.filter((g) => g.color === "black")),
        ratingFrom: rated.length ? rated[0].rating : null,
        ratingTo: rated.length ? rated[rated.length - 1].rating : null,
        avgOpponent: opp.length
            ? Math.round(opp.reduce((s, g) => s + (g.oppRating ?? 0), 0) / opp.length)
            : null,
        ratings: rated.map((g) => ({ date: g.end, rating: g.rating as number })),
        openings: openingRows(games),
        habits: habits(games, info),
        engine: evals ? engineStats(games, evals, (g) => openingFamily(g.opening)) : null,
    };
}

export type StatsReport = {
    current: PeriodStats;
    previous: PeriodStats;
    insights: Insight[];
};

export function statsReport(
    all: StatsGame[],
    filter: StatsFilter,
    now: number,
    evals?: Record<string, GameEval>,
): StatsReport {
    const info = sessions(all);
    const { current, previous } = periods(now, filter.days);
    const cur = periodStats(selectGames(all, filter, current), info, evals);
    const prev = periodStats(selectGames(all, filter, previous), info, evals);
    return { current: cur, previous: prev, insights: insights(cur, prev) };
}

// ---------------------------------------------------------------- Insights

export type Insight = {
    /** Translation key under Statistics.Insight. */
    key: string;
    tone: "good" | "bad" | "info";
    params: Record<string, string | number>;
    /** How much it matters (larger first). */
    weight: number;
};

/** Minimum games for an opening or a habit to say something about it. */
export const MIN_GAMES = 10;
/** Minimum difference (in points per game) worth mentioning. */
export const MIN_DIFF = 0.08;

const pct = (x: number) => Math.round(x * 100);

function weightOf(diff: number, n: number) {
    return Math.abs(diff) * Math.sqrt(n);
}

export function insights(cur: PeriodStats, prev: PeriodStats): Insight[] {
    const out: Insight[] = [];
    const base = performance(cur.total);

    // Openings that go much better or worse than the ratings say.
    for (const row of cur.openings) {
        if (row.family === UNKNOWN_OPENING || row.score.n < MIN_GAMES) continue;
        const diff = performance(row.score);
        if (Math.abs(diff) < MIN_DIFF + 0.02) continue;
        out.push({
            key: diff < 0 ? "OpeningBad" : "OpeningGood",
            tone: diff < 0 ? "bad" : "good",
            params: {
                opening: row.family,
                color: row.color,
                n: row.score.n,
                score: pct(row.score.score),
                expected: pct(row.score.expected ?? 0.5),
            },
            weight: weightOf(diff, row.score.n),
        });
    }

    // After a loss / after losses in a row.
    const h = cur.habits;
    for (const [key, s] of [
        ["AfterLoss", h.after.loss],
        ["AfterLossStreak", h.after.lossStreak],
    ] as const) {
        if (s.n < MIN_GAMES) continue;
        const diff = performance(s) - base;
        if (Math.abs(diff) < MIN_DIFF) continue;
        out.push({
            key: `${key}${diff < 0 ? "Bad" : "Good"}`,
            tone: diff < 0 ? "bad" : "good",
            params: { n: s.n, score: pct(s.score), expected: pct(s.expected ?? 0.5) },
            weight: weightOf(diff, s.n),
        });
    }

    // Long sessions: from the 4th game on, compared with the first three.
    const early = mergeScores([h.session["1"], h.session["2"], h.session["3"]]);
    const late = mergeScores([h.session["4-5"], h.session["6+"]]);
    if (late.n >= MIN_GAMES && early.n >= MIN_GAMES) {
        const diff = performance(late) - performance(early);
        if (Math.abs(diff) >= MIN_DIFF)
            out.push({
                key: diff < 0 ? "LongSessionBad" : "LongSessionGood",
                tone: diff < 0 ? "bad" : "good",
                params: {
                    n: late.n,
                    late: pct(performance(late)),
                    early: pct(performance(early)),
                },
                weight: weightOf(diff, late.n),
            });
    }

    // Stronger / weaker opponents.
    const stronger = mergeScores([h.opponents.stronger, h.opponents.muchStronger]);
    const weaker = mergeScores([h.opponents.weaker, h.opponents.muchWeaker]);
    for (const [kind, s] of [
        ["Stronger", stronger],
        ["Weaker", weaker],
    ] as const) {
        if (s.n < MIN_GAMES) continue;
        const diff = performance(s);
        if (Math.abs(diff) < MIN_DIFF) continue;
        out.push({
            key: `Opponents${kind}${diff < 0 ? "Bad" : "Good"}`,
            tone: diff < 0 ? "bad" : "good",
            params: { n: s.n, score: pct(s.score), expected: pct(s.expected ?? 0.5) },
            weight: weightOf(diff, s.n),
        });
    }

    // Losses on time.
    const losses = cur.total.losses;
    const onTime = h.endings.loss.time ?? 0;
    if (losses >= MIN_GAMES && onTime >= 3) {
        const share = onTime / losses;
        const prevLosses = prev.total.losses;
        const prevShare = prevLosses ? (prev.habits.endings.loss.time ?? 0) / prevLosses : null;
        if (share >= 0.15)
            out.push({
                key:
                    prevShare !== null && prevLosses >= MIN_GAMES
                        ? "TimeLossesCompared"
                        : "TimeLosses",
                tone: "bad",
                params: {
                    n: onTime,
                    share: pct(share),
                    previous: prevShare === null ? 0 : pct(prevShare),
                },
                weight: share * Math.sqrt(losses) * 1.5,
            });
    }

    // Compared with the previous period.
    if (cur.total.n >= 20 && prev.total.n >= 20) {
        const diff = performance(cur.total) - performance(prev.total);
        if (Math.abs(diff) >= 0.04)
            out.push({
                key: diff < 0 ? "TrendBad" : "TrendGood",
                tone: diff < 0 ? "bad" : "good",
                params: {
                    score: pct(cur.total.score),
                    previous: pct(prev.total.score),
                    diff: Math.abs(pct(diff)),
                },
                weight: weightOf(diff, cur.total.n) * 1.2,
            });
    }

    if (cur.engine) out.push(...engineInsights(cur.engine, prev.engine));

    return out.sort((a, b) => b.weight - a.weight);
}

/** Minimum analysed games for the engine's findings. */
export const MIN_ANALYSED = 10;

function engineInsights(e: EngineStats, p: EngineStats | null): Insight[] {
    const out: Insight[] = [];
    if (e.analysed < MIN_ANALYSED) return out;

    // Winning positions not converted / lost positions saved.
    const c = e.conversion;
    if (c.n >= 8) {
        const share = c.wins / c.n;
        if (share < 0.75 || share >= 0.92) {
            const bad = share < 0.75;
            out.push({
                key: bad ? "ConversionBad" : "ConversionGood",
                tone: bad ? "bad" : "good",
                params: { n: c.n, share: pct(share), draws: c.draws, losses: c.losses },
                weight: Math.abs(share - 0.85) * Math.sqrt(c.n) * 1.5,
            });
        }
    }
    const b = e.comebacks;
    if (b.n >= 8) {
        const saved = (b.wins + b.draws / 2) / b.n;
        if (saved >= 0.3 || saved <= 0.08)
            out.push({
                key: saved >= 0.3 ? "ComebacksGood" : "ComebacksBad",
                tone: saved >= 0.3 ? "good" : "info",
                params: { n: b.n, wins: b.wins, draws: b.draws },
                weight: Math.abs(saved - 0.15) * Math.sqrt(b.n),
            });
    }

    // Endgames: points against the evaluation when they started.
    const eg = e.endgames;
    if (eg.n >= MIN_GAMES) {
        const diff = (eg.score - eg.expected) / eg.n;
        if (Math.abs(diff) >= MIN_DIFF)
            out.push({
                key: diff < 0 ? "EndgamesBad" : "EndgamesGood",
                tone: diff < 0 ? "bad" : "good",
                params: { n: eg.n, diff: Math.abs(pct(diff)) },
                weight: weightOf(diff, eg.n),
            });
    }

    // Serious errors in time trouble.
    const tt = e.timeTrouble;
    if (tt.seriousWithClock >= 8 && tt.movesWithClock > 0) {
        const share = tt.seriousInTrouble / tt.seriousWithClock;
        const movesShare = tt.movesInTrouble / tt.movesWithClock;
        if (share >= 0.25 && share >= movesShare * 2)
            out.push({
                key: "TimeTroubleErrors",
                tone: "bad",
                params: { share: pct(share), moves: pct(movesShare), n: tt.seriousInTrouble },
                weight: share * Math.sqrt(tt.seriousWithClock),
            });
    }

    // The phase where serious errors are most frequent.
    const rates = PHASES.map((ph) => ({
        ph,
        rate: seriousRate(e.phases[ph]),
        moves: e.phases[ph].moves,
    }));
    const valid = rates.filter((r) => r.rate !== null && r.moves >= 100);
    if (valid.length >= 2) {
        const worst = valid.reduce((a, r) => ((r.rate as number) > (a.rate as number) ? r : a));
        const others = valid.filter((r) => r !== worst);
        const otherMoves = others.reduce((s, r) => s + r.moves, 0);
        const otherRate =
            (others.reduce((s, r) => s + ((r.rate as number) * r.moves) / 100, 0) / otherMoves) *
            100;
        if ((worst.rate as number) >= otherRate * 1.5 && (worst.rate as number) - otherRate >= 1)
            out.push({
                key: "PhaseErrors",
                tone: "bad",
                params: {
                    phase: worst.ph,
                    rate: Math.round((worst.rate as number) * 10) / 10,
                    other: Math.round(otherRate * 10) / 10,
                },
                weight: ((worst.rate as number) - otherRate) / 2,
            });
    }

    // Openings you leave clearly worse (or better), after move 15.
    for (const [key, v] of e.eval15ByOpening) {
        const [color, opening] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
        if (opening === UNKNOWN_OPENING || v.n < 8 || Math.abs(v.avg) < 60) continue;
        out.push({
            key: v.avg < 0 ? "Eval15Bad" : "Eval15Good",
            tone: v.avg < 0 ? "bad" : "good",
            params: { color, opening, n: v.n, eval: Math.round(v.avg) },
            // Same scale as the results: the expected score that evaluation is worth.
            weight: Math.abs(winChance(v.avg) / 100 - 0.5) * Math.sqrt(v.n),
        });
    }

    // Accuracy against the previous period.
    if (p && p.analysed >= 20 && e.analysed >= 20 && e.accuracy !== null && p.accuracy !== null) {
        const diff = e.accuracy - p.accuracy;
        if (Math.abs(diff) >= 2.5)
            out.push({
                key: diff < 0 ? "AccuracyBad" : "AccuracyGood",
                tone: diff < 0 ? "bad" : "good",
                params: {
                    accuracy: Math.round(e.accuracy * 10) / 10,
                    previous: Math.round(p.accuracy * 10) / 10,
                },
                weight: (Math.abs(diff) / 100) * Math.sqrt(e.analysed) * 3,
            });
    }
    return out;
}

export function mergeScores(scores: Score[]): Score {
    let n = 0;
    let wins = 0;
    let draws = 0;
    let expSum = 0;
    let expN = 0;
    for (const s of scores) {
        n += s.n;
        wins += s.wins;
        draws += s.draws;
        if (s.expected !== null) {
            expSum += s.expected * s.n;
            expN += s.n;
        }
    }
    return {
        n,
        wins,
        draws,
        losses: n - wins - draws,
        score: n ? (wins + draws / 2) / n : 0,
        expected: expN ? expSum / expN : null,
    };
}
