// Games of one account for the Statistics page: downloaded only when asked, with
// everything the statistics need (all moves, clocks, ratings, how the game ended),
// and kept in a file of the app.

import { appDataDir, resolve } from "@tauri-apps/api/path";
import { exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { fetch } from "@tauri-apps/plugin-http";
import { atom, getDefaultStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { commands } from "@/bindings";
import { sessionsAtom } from "@/state/atoms";
import {
    type ChessComApiGame,
    chessComGame,
    type LichessApiGame,
    lichessGame,
    type StatsGame,
} from "@/utils/accountStats";
import { apiHeaders } from "@/utils/http";

const DAY = 24 * 3600 * 1000;

export const PERIODS = [30, 90, 180, 365] as const;
export const STATS_SPEEDS = ["bullet", "blitz", "rapid", "classical", "correspondence"] as const;

export type StatsSettings = {
    /** "chesscom:<user>" or "lichess:<user>". */
    account: string | null;
    speed: string;
    days: number;
    ratedOnly: boolean;
};

export const statsSettingsAtom = atomWithStorage<StatsSettings>(
    "account-stats-settings",
    { account: null, speed: "rapid", days: 180, ratedOnly: true },
    undefined,
    { getOnInit: true },
);

export type AccountGames = {
    /** Games are complete from `from` to `to` (ms). */
    from: number;
    to: number;
    games: StatsGame[];
};

type StatsFile = { version: 1; accounts: Record<string, AccountGames> };

export const statsGamesAtom = atom<StatsFile | null>(null);

export type StatsDownload = {
    running: boolean;
    message: string;
    error: string | null;
    added: number | null;
};

export const statsDownloadAtom = atom<StatsDownload>({
    running: false,
    message: "",
    error: null,
    added: null,
});

async function storePath() {
    return resolve(await appDataDir(), "account-stats.json");
}

export async function loadStatsGames(): Promise<StatsFile> {
    const store = getDefaultStore();
    const cached = store.get(statsGamesAtom);
    if (cached) return cached;
    let data: StatsFile = { version: 1, accounts: {} };
    try {
        const path = await storePath();
        if (await exists(path)) data = JSON.parse(await readTextFile(path)) as StatsFile;
    } catch {
        // unreadable: start again
    }
    store.set(statsGamesAtom, data);
    return data;
}

async function saveStatsGames(data: StatsFile) {
    getDefaultStore().set(statsGamesAtom, data);
    await writeTextFile(await storePath(), JSON.stringify(data));
}

/** Time ranges still to download so that the account covers the period and the one before. */
export function missingRanges(
    entry: AccountGames | undefined,
    days: number,
    now: number,
): [number, number][] {
    const need = now - 2 * days * DAY;
    if (!entry) return [[need, now]];
    const out: [number, number][] = [];
    if (need < entry.from) out.push([need, entry.from]);
    out.push([entry.to, now]);
    return out;
}

/** True when the downloaded games do not reach back to the start of the previous period. */
export function needsOlderGames(entry: AccountGames | undefined, days: number, now: number) {
    return !entry || entry.from > now - 2 * days * DAY + DAY;
}

type Progress = (message: string) => void;

async function downloadChessCom(user: string, ranges: [number, number][], progress: Progress) {
    const base = `https://api.chess.com/pub/player/${user.toLowerCase()}/games/archives`;
    const res = await fetch(base, { headers: apiHeaders() });
    if (!res.ok) throw new Error(`Chess.com ${user}: ${res.status}`);
    const archives = ((await res.json()) as { archives: string[] }).archives;
    const games: StatsGame[] = [];
    for (const url of archives) {
        const [year, month] = url.split("/").slice(-2).map(Number);
        // The archive month, with a day of margin for time zones.
        const monthStart = Date.UTC(year, month - 1, 1) - DAY;
        const monthEnd = Date.UTC(year, month, 1) + DAY;
        if (!ranges.some(([from, to]) => monthStart < to && monthEnd > from)) continue;
        progress(`${String(month).padStart(2, "0")}/${year}`);
        const r = await fetch(url, { headers: apiHeaders() });
        if (!r.ok) throw new Error(`Chess.com ${user} ${month}/${year}: ${r.status}`);
        for (const g of ((await r.json()) as { games: ChessComApiGame[] }).games) {
            const game = chessComGame(g, user);
            if (game) games.push(game);
        }
    }
    return games;
}

async function downloadLichess(
    user: string,
    ranges: [number, number][],
    token: string | undefined,
    progress: Progress,
) {
    const games: StatsGame[] = [];
    for (const [since, until] of ranges) {
        const params = new URLSearchParams({
            since: String(Math.floor(since)),
            until: String(Math.ceil(until)),
            moves: "true",
            clocks: "true",
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
        const onLine = (line: string) => {
            if (!line.trim()) return;
            const game = lichessGame(JSON.parse(line) as LichessApiGame, user);
            if (game) games.push(game);
        };
        const reader = res.body?.getReader();
        if (reader) {
            // Read as it arrives, to show how many games came already.
            const decoder = new TextDecoder();
            let buffer = "";
            let lines = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split("\n");
                buffer = parts.pop() ?? "";
                for (const p of parts) {
                    onLine(p);
                    lines++;
                }
                progress(String(lines));
            }
            onLine(buffer + decoder.decode());
        } else {
            (await res.text()).split("\n").forEach(onLine);
        }
    }
    return games;
}

/** Names the openings of the games (with the app's openings table). */
async function nameOpenings(games: StatsGame[]) {
    for (let i = 0; i < games.length; i += 500) {
        const batch = games.slice(i, i + 500);
        const res = await commands.openingNames(
            batch.map((g) => (g.moves ? g.moves.split(" ") : [])),
        );
        if (res.status !== "ok") throw new Error(res.error);
        res.data.forEach((name, j) => {
            batch[j].opening = name;
        });
    }
}

/** Downloads what is missing for the account to cover the period and the one before it. */
export async function downloadStatsGames(account: string, days: number) {
    const store = getDefaultStore();
    if (store.get(statsDownloadAtom).running) return;
    store.set(statsDownloadAtom, { running: true, message: "", error: null, added: null });
    try {
        const data = await loadStatsGames();
        const now = Date.now();
        const entry = data.accounts[account];
        const ranges = missingRanges(entry, days, now);
        const source = account.slice(0, account.indexOf(":"));
        const user = account.slice(account.indexOf(":") + 1);
        const label = source === "chesscom" ? `Chess.com · ${user}` : `Lichess · ${user}`;
        const progress: Progress = (m) =>
            store.set(statsDownloadAtom, (s) => ({ ...s, message: `${label} · ${m}` }));
        progress("…");
        let got: StatsGame[];
        if (source === "chesscom") {
            got = await downloadChessCom(user, ranges, progress);
        } else {
            const unsubscribe = store.sub(sessionsAtom, () => {});
            const token = store
                .get(sessionsAtom)
                .find((s) => s.lichess?.username.toLowerCase() === user.toLowerCase())
                ?.lichess?.accessToken;
            unsubscribe();
            got = await downloadLichess(user, ranges, token, progress);
        }
        const known = new Map((entry?.games ?? []).map((g) => [g.id, g]));
        const fresh = got.filter((g) => !known.has(g.id));
        await nameOpenings(fresh);
        for (const g of fresh) known.set(g.id, g);
        const games = [...known.values()].sort((a, b) => a.end - b.end);
        const from = Math.min(entry?.from ?? Number.POSITIVE_INFINITY, ranges[0][0]);
        await saveStatsGames({
            version: 1,
            accounts: { ...data.accounts, [account]: { from, to: now, games } },
        });
        store.set(statsDownloadAtom, {
            running: false,
            message: "",
            error: null,
            added: fresh.length,
        });
    } catch (e) {
        store.set(statsDownloadAtom, {
            running: false,
            message: "",
            error: e instanceof Error ? e.message : String(e),
            added: null,
        });
    }
}
