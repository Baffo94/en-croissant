import { describe, expect, it } from "vitest";
import {
    chessComGame,
    expectedScore,
    habits,
    insights,
    lichessGame,
    openingFamily,
    openingRows,
    periods,
    scoreOf,
    selectGames,
    sessions,
    type StatsGame,
    statsReport,
} from "../accountStats";

const PGN = `[Event "Live Chess"]
[Site "Chess.com"]
[Date "2026.10.03"]
[White "Baffo94"]
[Black "rival"]
[Result "0-1"]
[ECO "B13"]
[WhiteElo "1650"]
[BlackElo "1700"]
[TimeControl "600"]
[Termination "rival won on time"]
[UTCDate "2026.10.03"]
[UTCTime "18:20:11"]
[StartTime "20:20:11"]
[EndDate "2026.10.03"]
[EndTime "20:40:00"]

1. e4 {[%clk 0:09:58.5]} 1... c6 {[%clk 0:09:59]} 2. d4 {[%clk 0:09:50.1]} 2... d5 {[%clk 0:09:57]} 0-1`;

describe("chessComGame", () => {
    const api = {
        url: "https://www.chess.com/game/live/1",
        pgn: PGN,
        end_time: Date.UTC(2026, 9, 3, 18, 40) / 1000,
        rated: true,
        rules: "chess",
        time_class: "rapid",
        time_control: "600",
        initial_setup: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        white: { username: "Baffo94", rating: 1650, result: "timeout" },
        black: { username: "rival", rating: 1700, result: "win" },
    };

    it("reads moves, clocks, ratings, result and ending", () => {
        const g = chessComGame(api, "baffo94");
        expect(g).toMatchObject({
            id: api.url,
            color: "white",
            rating: 1650,
            oppRating: 1700,
            opponent: "rival",
            result: "loss",
            ending: "time",
            speed: "rapid",
            timeControl: "600",
            moves: "e4 c6 d4 d5",
            clocks: [5985, 5990, 5901, 5970],
            start: Date.UTC(2026, 9, 3, 18, 20, 11),
        });
    });

    it("takes the ending of a win from the opponent's result", () => {
        const g = chessComGame(
            {
                ...api,
                white: { ...api.white, result: "win" },
                black: { ...api.black, result: "checkmated" },
            },
            "Baffo94",
        );
        expect(g?.result).toBe("win");
        expect(g?.ending).toBe("mate");
    });

    it("recognises draws and skips other variants", () => {
        const g = chessComGame(
            {
                ...api,
                white: { ...api.white, result: "repetition" },
                black: { ...api.black, result: "repetition" },
            },
            "rival",
        );
        expect(g).toMatchObject({ color: "black", result: "draw", ending: "repetition" });
        expect(chessComGame({ ...api, rules: "chess960" }, "rival")).toBeNull();
        expect(chessComGame({ ...api, time_class: "daily" }, "rival")?.speed).toBe(
            "correspondence",
        );
    });
});

describe("lichessGame", () => {
    const api = {
        id: "abcd1234",
        rated: true,
        variant: "standard",
        speed: "rapid",
        createdAt: 1000,
        lastMoveAt: 5000,
        status: "outoftime",
        winner: "black" as const,
        moves: "e4 e5 Nf3",
        clocks: [60003, 60000, 59000],
        clock: { initial: 600, increment: 5 },
        players: {
            white: { user: { name: "Baffo94" }, rating: 1800 },
            black: { user: { name: "rival" }, rating: 1750 },
        },
    };
    it("reads the game", () => {
        expect(lichessGame(api, "baffo94")).toMatchObject({
            id: "lichess:abcd1234",
            color: "white",
            result: "loss",
            ending: "time",
            timeControl: "600+5",
            clocks: [6000, 6000, 5900],
            start: 1000,
            end: 5000,
        });
    });
    it("handles draws on time and skips aborted games", () => {
        expect(lichessGame({ ...api, winner: undefined }, "rival")).toMatchObject({
            color: "black",
            result: "draw",
            ending: "timeVsInsufficient",
        });
        expect(lichessGame({ ...api, status: "aborted" }, "rival")).toBeNull();
        expect(lichessGame(api, "someoneElse")).toBeNull();
    });
});

let counter = 0;
function game(over: Partial<StatsGame>): StatsGame {
    counter++;
    return {
        id: `g${counter}`,
        source: "chesscom",
        url: "",
        start: 0,
        end: 0,
        speed: "rapid",
        timeControl: "600",
        rated: true,
        color: "white",
        rating: 1500,
        oppRating: 1500,
        opponent: "x",
        result: "win",
        ending: "resign",
        moves: "",
        clocks: [],
        opening: null,
        ...over,
    };
}

const MIN = 60 * 1000;

describe("sessions and habits", () => {
    it("splits sessions on 30-minute gaps and tracks the previous result", () => {
        const games = [
            game({ start: 0, end: 10 * MIN, result: "loss" }),
            game({ start: 15 * MIN, end: 25 * MIN, result: "loss" }),
            game({ start: 30 * MIN, end: 40 * MIN, result: "win" }),
            game({ start: 200 * MIN, end: 210 * MIN, result: "draw" }),
        ];
        const info = sessions(games);
        expect(games.map((g) => info.get(g.id))).toEqual([
            { index: 1, previous: null, lossStreak: 0 },
            { index: 2, previous: "loss", lossStreak: 1 },
            { index: 3, previous: "loss", lossStreak: 2 },
            { index: 1, previous: null, lossStreak: 0 },
        ]);
        const h = habits(games, info);
        expect(h.after.loss.n).toBe(2);
        expect(h.after.loss.score).toBe(0.5);
        expect(h.after.lossStreak.n).toBe(1);
        expect(h.after.first.n).toBe(2);
        expect(h.session["3"].n).toBe(1);
        expect(h.endings.loss.resign).toBe(2);
    });
});

describe("scores and openings", () => {
    it("computes the expected score from the ratings", () => {
        expect(expectedScore(game({ rating: 1500, oppRating: 1500 }))).toBeCloseTo(0.5);
        expect(expectedScore(game({ rating: 1500, oppRating: 1900 }))).toBeCloseTo(1 / 11);
        expect(expectedScore(game({ oppRating: null }))).toBeNull();
        const s = scoreOf([game({ result: "win" }), game({ result: "draw" })]);
        expect(s).toMatchObject({ n: 2, wins: 1, draws: 1, losses: 0, score: 0.75 });
    });

    it("groups openings by family and colour", () => {
        expect(openingFamily("Caro-Kann Defense: Panov Attack")).toBe("Caro-Kann Defense");
        expect(openingFamily(null)).toBe("?");
        const rows = openingRows([
            game({ color: "black", opening: "Caro-Kann Defense: Panov Attack" }),
            game({ color: "black", opening: "Caro-Kann Defense: Advance Variation" }),
            game({ color: "black", opening: "Caro-Kann Defense: Panov Attack" }),
            game({ color: "white", opening: "Caro-Kann Defense: Panov Attack" }),
        ]);
        expect(rows.map((r) => [r.color, r.family, r.score.n])).toEqual([
            ["black", "Caro-Kann Defense", 3],
            ["white", "Caro-Kann Defense", 1],
        ]);
        expect(rows[0].variations.map((v) => [v.name, v.score.n])).toEqual([
            ["Caro-Kann Defense: Panov Attack", 2],
            ["Caro-Kann Defense: Advance Variation", 1],
        ]);
    });
});

describe("report", () => {
    const DAY = 24 * 3600 * 1000;
    const now = 400 * DAY;

    it("selects the period, the speed and rated games", () => {
        const games = [
            game({ end: now - 10 * DAY }),
            game({ end: now - 10 * DAY, speed: "blitz" }),
            game({ end: now - 10 * DAY, rated: false }),
            game({ end: now - 200 * DAY }),
        ];
        const { current, previous } = periods(now, 180);
        const filter = { speed: "rapid", ratedOnly: true, days: 180 };
        expect(selectGames(games, filter, current)).toHaveLength(1);
        expect(selectGames(games, filter, previous)).toHaveLength(1);
        expect(selectGames(games, { ...filter, ratedOnly: false }, current)).toHaveLength(2);
    });

    it("finds a bad opening, tilt after losses and losses on time", () => {
        const games: StatsGame[] = [];
        let t = now - 100 * DAY;
        // 20 Caro-Kann games as Black: 4 wins out of 20 against equal opponents.
        for (let i = 0; i < 20; i++) {
            games.push(
                game({
                    start: t,
                    end: t + 10 * MIN,
                    color: "black",
                    opening: "Caro-Kann Defense: Panov Attack",
                    result: i % 5 === 0 ? "win" : "loss",
                    ending: i % 2 ? "time" : "resign",
                }),
            );
            t += 15 * MIN;
        }
        // Pause, then 20 Italian games as White, all won (one per session).
        for (let i = 0; i < 20; i++) {
            t += DAY;
            games.push(
                game({ start: t, end: t + 10 * MIN, opening: "Italian Game", result: "win" }),
            );
        }
        const report = statsReport(games, { speed: "rapid", ratedOnly: true, days: 180 }, now);
        expect(report.current.total.n).toBe(40);
        expect(report.previous.total.n).toBe(0);
        const keys = report.insights.map((i) => i.key);
        expect(keys).toContain("OpeningBad");
        expect(keys).toContain("OpeningGood");
        expect(keys).toContain("AfterLossBad");
        expect(keys).toContain("LongSessionBad");
        expect(keys).toContain("TimeLosses");
        const bad = report.insights.find((i) => i.key === "OpeningBad");
        expect(bad?.params).toMatchObject({
            opening: "Caro-Kann Defense",
            color: "black",
            n: 20,
            score: 20,
            expected: 50,
        });
    });

    it("says nothing on small samples", () => {
        const games = [game({ end: now - DAY, opening: "Italian Game", result: "loss" })];
        const report = statsReport(games, { speed: "rapid", ratedOnly: true, days: 180 }, now);
        expect(report.insights).toEqual([]);
        expect(insights(report.current, report.previous)).toEqual([]);
    });
});
