// Your games, downloaded on request from the Chess.com and Lichess accounts linked in
// the Accounts page, and kept in a file of the app (only what the comparison needs).

import { appDataDir, resolve } from "@tauri-apps/api/path";
import { exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { fetch } from "@tauri-apps/plugin-http";
import { atom, getDefaultStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { sessionsAtom } from "@/state/atoms";
import { MAX_PLIES, movesOfPgn, normaliseMoves, type StoredGame } from "@/utils/gamesVsRepertoire";
import { apiHeaders } from "@/utils/http";

export const SPEEDS = ["bullet", "blitz", "rapid", "classical", "correspondence"] as const;

export type GamesSettings = {
    /** Accounts used: "chesscom:<user>" or "lichess:<user>". */
    accounts: string[];
    speeds: string[];
    /** Months downloaded the first time an account is used (0 = everything). */
    months: number;
};

export const gamesSettingsAtom = atomWithStorage<GamesSettings>(
    "repertoire-games-settings",
    { accounts: [], speeds: ["rapid"], months: 3 },
    undefined,
    { getOnInit: true },
);

/** Problems marked "ignore" (this computer only). */
export const gamesIgnoredAtom = atomWithStorage<string[]>(
    "repertoire-games-ignored",
    [],
    undefined,
    {
        getOnInit: true,
    },
);

/** Problems sent to review: key -> date (to show it in the list). */
export const gamesReviewedAtom = atomWithStorage<Record<string, string>>(
    "repertoire-games-reviewed",
    {},
    undefined,
    { getOnInit: true },
);

type GamesFile = { version: 1; fetched: Record<string, number>; games: StoredGame[] };

export const gamesAtom = atom<GamesFile | null>(null);

export type DownloadState = {
    running: boolean;
    message: string;
    error: string | null;
    added: number | null;
};
export const downloadStateAtom = atom<DownloadState>({
    running: false,
    message: "",
    error: null,
    added: null,
});

async function storePath() {
    return resolve(await appDataDir(), "repertoire-games.json");
}

export async function loadGames(): Promise<GamesFile> {
    const store = getDefaultStore();
    const cached = store.get(gamesAtom);
    if (cached) return cached;
    let data: GamesFile = { version: 1, fetched: {}, games: [] };
    try {
        const path = await storePath();
        if (await exists(path)) data = JSON.parse(await readTextFile(path)) as GamesFile;
    } catch {
        // unreadable: start again
    }
    store.set(gamesAtom, data);
    return data;
}

async function saveGames(data: GamesFile) {
    getDefaultStore().set(gamesAtom, data);
    await writeTextFile(await storePath(), JSON.stringify(data));
}

/** Linked accounts, as "chesscom:<user>" / "lichess:<user>" with a label. */
export function linkedAccounts(): { key: string; label: string }[] {
    const store = getDefaultStore();
    const unsubscribe = store.sub(sessionsAtom, () => {});
    const sessions = store.get(sessionsAtom);
    unsubscribe();
    const out: { key: string; label: string }[] = [];
    for (const s of sessions) {
        if (s.chessCom)
            out.push({
                key: `chesscom:${s.chessCom.username}`,
                label: `Chess.com · ${s.chessCom.username}`,
            });
        if (s.lichess)
            out.push({
                key: `lichess:${s.lichess.username}`,
                label: `Lichess · ${s.lichess.username}`,
            });
    }
    return out;
}

const DRAWS = new Set([
    "agreed",
    "repetition",
    "stalemate",
    "insufficient",
    "50move",
    "timevsinsufficient",
]);

type ChessComGame = {
    url: string;
    pgn?: string | null;
    end_time: number;
    rules: string;
    time_class?: string;
    initial_setup?: string;
    white: { username: string; result: string };
    black: { username: string; result: string };
};

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

async function downloadChessCom(user: string, since: number, onMonth: (m: string) => void) {
    const base = `https://api.chess.com/pub/player/${user.toLowerCase()}/games/archives`;
    const res = await fetch(base, { headers: apiHeaders() });
    if (!res.ok) throw new Error(`Chess.com ${user}: ${res.status}`);
    const archives = ((await res.json()) as { archives: string[] }).archives;
    const sinceDate = new Date(since);
    const firstMonth = new Date(sinceDate.getFullYear(), sinceDate.getMonth(), 1);
    const games: StoredGame[] = [];
    for (const url of archives) {
        const [year, month] = url.split("/").slice(-2).map(Number);
        if (new Date(year, month - 1, 1) < firstMonth) continue;
        onMonth(`${month}/${year}`);
        const r = await fetch(url, { headers: apiHeaders() });
        if (!r.ok) throw new Error(`Chess.com ${user} ${month}/${year}: ${r.status}`);
        for (const g of ((await r.json()) as { games: ChessComGame[] }).games) {
            if (g.rules !== "chess" || !g.pgn || g.end_time * 1000 <= since) continue;
            if (g.initial_setup && g.initial_setup !== START) continue;
            const moves = movesOfPgn(g.pgn);
            if (!moves) continue;
            const white = g.white.username.toLowerCase() === user.toLowerCase();
            const me = white ? g.white : g.black;
            const opponent = white ? g.black : g.white;
            games.push({
                id: g.url,
                source: "chesscom",
                account: user,
                url: g.url,
                date: g.end_time * 1000,
                speed: g.time_class === "daily" ? "correspondence" : (g.time_class ?? "rapid"),
                myColor: white ? "white" : "black",
                opponent: opponent.username,
                result: me.result === "win" ? "win" : DRAWS.has(me.result) ? "draw" : "loss",
                moves,
            });
        }
    }
    return games;
}

type LichessGame = {
    id: string;
    variant: string;
    speed: string;
    createdAt: number;
    initialFen?: string;
    winner?: "white" | "black";
    status: string;
    moves: string;
    players: { white: { user?: { name: string } }; black: { user?: { name: string } } };
};

async function downloadLichess(user: string, since: number, token: string | undefined) {
    const params = new URLSearchParams({
        since: String(since + 1),
        moves: "true",
        clocks: "false",
        evals: "false",
        opening: "false",
    });
    const res = await fetch(
        `https://lichess.org/api/games/user/${encodeURIComponent(user)}?${params}`,
        {
            headers: apiHeaders({
                Accept: "application/x-ndjson",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            }),
        },
    );
    if (!res.ok) throw new Error(`Lichess ${user}: ${res.status}`);
    const games: StoredGame[] = [];
    for (const line of (await res.text()).split("\n")) {
        if (!line.trim()) continue;
        const g = JSON.parse(line) as LichessGame;
        if (g.variant !== "standard" || g.initialFen) continue;
        const white = g.players.white.user?.name.toLowerCase() === user.toLowerCase();
        games.push({
            id: `lichess:${g.id}`,
            source: "lichess",
            account: user,
            url: `https://lichess.org/${g.id}${white ? "" : "/black"}`,
            date: g.createdAt,
            speed: g.speed,
            myColor: white ? "white" : "black",
            opponent: (white ? g.players.black.user?.name : g.players.white.user?.name) ?? "?",
            result: !g.winner ? "draw" : (g.winner === "white") === white ? "win" : "loss",
            moves: normaliseMoves(g.moves.split(" ").slice(0, MAX_PLIES)),
        });
    }
    return games;
}

/** Downloads the new games of the chosen accounts (only when asked). */
export async function downloadGames(settings: GamesSettings) {
    const store = getDefaultStore();
    if (store.get(downloadStateAtom).running) return;
    store.set(downloadStateAtom, { running: true, message: "", error: null, added: null });
    try {
        const data = await loadGames();
        const known = new Set(data.games.map((g) => g.id));
        const unsubscribe = store.sub(sessionsAtom, () => {});
        const token = store.get(sessionsAtom).find((s) => s.lichess?.accessToken)
            ?.lichess?.accessToken;
        unsubscribe();
        const firstSince =
            settings.months > 0 ? Date.now() - settings.months * 30.5 * 24 * 3600 * 1000 : 0;
        let added = 0;
        const fetched = { ...data.fetched };
        let games = [...data.games];
        for (const key of settings.accounts) {
            const [source, user] = [
                key.slice(0, key.indexOf(":")),
                key.slice(key.indexOf(":") + 1),
            ];
            const since = fetched[key] ?? firstSince;
            const label = source === "chesscom" ? `Chess.com · ${user}` : `Lichess · ${user}`;
            store.set(downloadStateAtom, (s) => ({ ...s, message: label }));
            const got =
                source === "chesscom"
                    ? await downloadChessCom(user, since, (m) =>
                          store.set(downloadStateAtom, (s) => ({
                              ...s,
                              message: `${label} · ${m}`,
                          })),
                      )
                    : await downloadLichess(user, since, token);
            const fresh = got.filter((g) => !known.has(g.id));
            fresh.forEach((g) => known.add(g.id));
            games = [...games, ...fresh];
            added += fresh.length;
            fetched[key] = Math.max(since, ...got.map((g) => g.date));
        }
        games.sort((a, b) => b.date - a.date);
        await saveGames({ version: 1, fetched, games });
        store.set(downloadStateAtom, { running: false, message: "", error: null, added });
    } catch (e) {
        store.set(downloadStateAtom, {
            running: false,
            message: "",
            error: e instanceof Error ? e.message : String(e),
            added: null,
        });
    }
}
