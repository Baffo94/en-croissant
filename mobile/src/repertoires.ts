import { buildFromTree, getStats, syncDeck, type PracticeData } from "@/components/files/opening";
import { type PgnGame, parsePgnGames } from "@/utils/pgnTree";
import { decodeBase64, getState, setDeck, type AppState } from "./state";

export type RepertoireEntry = {
    /** PGN path relative to the repository's repertoires/ folder */
    rel: string;
    game: number;
    name: string;
    folder: string;
    orientation: "white" | "black";
    stats: ReturnType<typeof getStats>;
    /** Left out of reviews and "Allena tutto". */
    paused: boolean;
};

type Content = Pick<AppState, "files" | "decks" | "pauses">;

const parseCache = new Map<string, PgnGame[]>();

/** Parsed games of a PGN file (cached by content). */
export function gamesOf(state: Content, rel: string): PgnGame[] {
    const b64 = state.files[rel];
    if (b64 === undefined) return [];
    const key = `${rel}\n${b64}`;
    let games = parseCache.get(key);
    if (!games) {
        try {
            games = parsePgnGames(new TextDecoder().decode(decodeBase64(b64)));
        } catch {
            games = [];
        }
        for (const k of parseCache.keys()) if (k.startsWith(`${rel}\n`)) parseCache.delete(k);
        parseCache.set(key, games);
    }
    return games;
}

function fileType(state: Content, rel: string): string | null {
    const info = state.files[rel.replace(/\.pgn$/i, ".info")];
    if (!info) return null;
    try {
        return JSON.parse(new TextDecoder().decode(decodeBase64(info))).type ?? null;
    } catch {
        return null;
    }
}

export function listRepertoires(state: Content): RepertoireEntry[] {
    const entries: RepertoireEntry[] = [];
    const pgns = Object.keys(state.files)
        .filter((p) => p.toLowerCase().endsWith(".pgn"))
        .filter((p) => {
            const type = fileType(state, p);
            return type === null || type === "repertoire";
        })
        .sort((a, b) => a.localeCompare(b));
    for (const rel of pgns) {
        const games = gamesOf(state, rel);
        const slash = rel.lastIndexOf("/");
        const folder = slash >= 0 ? rel.slice(0, slash) : "";
        const base = rel.slice(slash + 1).replace(/\.pgn$/i, "");
        games.forEach((g, i) => {
            const deck = state.decks[rel]?.[String(i)];
            const positions =
                deck && deck.positions.length > 0
                    ? deck.positions
                    : buildFromTree(g.root, g.orientation, g.start);
            const event = g.headers.get("Event");
            const name =
                games.length > 1
                    ? `${base} · ${event && event !== "?" ? event : `#${i + 1}`}`
                    : base;
            entries.push({
                rel,
                game: i,
                name,
                folder,
                orientation: g.orientation,
                stats: getStats(positions),
                paused: state.pauses?.[rel]?.paused === true,
            });
        });
    }
    return entries;
}

/**
 * Deck for a game, kept in line with the PGN the same way the desktop practice panel
 * does: new positions are added, removed ones dropped, progress of the others kept.
 */
export function prepareDeck(
    rel: string,
    game: number,
): { deck: PracticeData; pgn: PgnGame } | null {
    const state = getState();
    const pgn = gamesOf(state, rel)[game];
    if (!pgn) return null;
    const existing = state.decks[rel]?.[String(game)];
    let deck: PracticeData;
    if (!existing || existing.positions.length === 0) {
        deck = {
            positions: buildFromTree(pgn.root, pgn.orientation, pgn.start),
            logs: existing?.logs ?? [],
        };
        if (deck.positions.length > 0) setDeck(rel, String(game), deck);
    } else {
        const { positions, added, removed } = syncDeck(
            existing.positions,
            pgn.root,
            pgn.orientation,
            pgn.start,
        );
        deck = { ...existing, positions };
        if (added > 0 || removed > 0) setDeck(rel, String(game), deck);
    }
    return { deck, pgn };
}
