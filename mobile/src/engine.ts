// Stockfish 19 (lite, single-threaded WASM) running in a Web Worker, spoken to via UCI.

import { parseUci } from "chessops";
import { makeFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import { positionFromFen } from "@/utils/chessops";

export type Score = { type: "cp" | "mate"; value: number };

export type EngineLine = {
    multipv: number;
    depth: number;
    /** From White's point of view. */
    score: Score;
    /** Principal variation in UCI. */
    pv: string[];
};

export type Analysis = {
    fen: string;
    depth: number;
    lines: EngineLine[];
    done: boolean;
};

const ENGINE_URL = "engine/stockfish-19-lite-single.js";

function parseInfo(line: string, whiteToMove: boolean): EngineLine | null {
    if (!line.startsWith("info ") || !line.includes(" pv ")) return null;
    const tokens = line.split(" ");
    const get = (key: string) => {
        const i = tokens.indexOf(key);
        return i >= 0 ? tokens[i + 1] : undefined;
    };
    const scoreIndex = tokens.indexOf("score");
    if (scoreIndex < 0) return null;
    // Lower/upper bounds are intermediate results: skip them.
    if (tokens[scoreIndex + 3] === "lowerbound" || tokens[scoreIndex + 3] === "upperbound")
        return null;
    const type = tokens[scoreIndex + 1] as "cp" | "mate";
    const raw = Number(tokens[scoreIndex + 2]);
    const pv = tokens.slice(tokens.indexOf("pv") + 1);
    return {
        multipv: Number(get("multipv") ?? 1),
        depth: Number(get("depth") ?? 0),
        score: { type, value: whiteToMove ? raw : -raw },
        pv,
    };
}

export class Engine {
    private worker: Worker;
    private ready: Promise<void>;
    private current: {
        fen: string;
        onUpdate: (a: Analysis) => void;
        lines: Map<number, EngineLine>;
    } | null = null;
    private pending: {
        fen: string;
        onUpdate: (a: Analysis) => void;
        multiPv: number;
        depth: number;
    } | null = null;
    private searching = false;

    constructor() {
        this.worker = new Worker(new URL(ENGINE_URL, document.baseURI).href);
        let resolveReady: () => void;
        this.ready = new Promise((r) => (resolveReady = r));
        this.worker.onmessage = (e: MessageEvent<string>) => {
            const line = String(e.data);
            if (line === "uciok") {
                this.send("setoption name Threads value 1");
                this.send("setoption name Hash value 32");
                this.send("isready");
            } else if (line === "readyok") {
                resolveReady();
            } else if (line.startsWith("bestmove")) {
                this.searching = false;
                if (this.current) {
                    this.emit(true);
                }
                this.startPending();
            } else if (this.current && line.startsWith("info ")) {
                const whiteToMove = this.current.fen.split(" ")[1] !== "b";
                const info = parseInfo(line, whiteToMove);
                if (info) {
                    this.current.lines.set(info.multipv, info);
                    this.emit(false);
                }
            }
        };
        this.send("uci");
    }

    private send(cmd: string) {
        this.worker.postMessage(cmd);
    }

    private emit(done: boolean) {
        if (!this.current) return;
        const lines = [...this.current.lines.values()].sort((a, b) => a.multipv - b.multipv);
        // Report only once every line reached the same depth, so they are comparable.
        const depth = Math.min(...lines.map((l) => l.depth));
        this.current.onUpdate({ fen: this.current.fen, depth, lines, done });
    }

    private startPending() {
        if (!this.pending || this.searching) return;
        const { fen, onUpdate, multiPv, depth } = this.pending;
        this.pending = null;
        this.current = { fen, onUpdate, lines: new Map() };
        this.searching = true;
        this.send(`setoption name MultiPV value ${multiPv}`);
        this.send(`position fen ${fen}`);
        this.send(`go depth ${depth}`);
    }

    /** Analyses `fen`, replacing any running analysis. */
    async analyse(
        fen: string,
        onUpdate: (a: Analysis) => void,
        options: { multiPv?: number; depth?: number } = {},
    ) {
        await this.ready;
        this.pending = { fen, onUpdate, multiPv: options.multiPv ?? 3, depth: options.depth ?? 22 };
        if (this.searching) {
            // The new search starts when the engine reports "bestmove" for the old one.
            this.current = null;
            this.send("stop");
        } else {
            this.startPending();
        }
    }

    stop() {
        this.pending = null;
        this.current = null;
        if (this.searching) this.send("stop");
    }

    destroy() {
        this.stop();
        this.worker.terminate();
    }
}

/** Converts a UCI principal variation to SAN moves (stops at the first illegal move). */
export function pvToSan(fen: string, pv: string[], max = 8): string[] {
    const [pos] = positionFromFen(fen);
    if (!pos) return [];
    const sans: string[] = [];
    for (const uci of pv.slice(0, max)) {
        const move = parseUci(uci);
        if (!move || !pos.isLegal(move)) break;
        sans.push(makeSan(pos, move));
        pos.play(move);
    }
    return sans;
}

/** "+0.35", "-1.20", "#3", "#-2" */
export function formatScore(score: Score): string {
    if (score.type === "mate") return `#${score.value}`;
    const pawns = score.value / 100;
    return `${pawns > 0 ? "+" : ""}${pawns.toFixed(2)}`;
}

/** White's share of the evaluation bar (0..100), same curve as Lichess. */
export function whiteBar(score: Score): number {
    if (score.type === "mate") return score.value > 0 ? 100 : 0;
    const winning = 2 / (1 + Math.exp(-0.00368208 * score.value)) - 1;
    return 50 + 50 * winning;
}

export function fenAfter(fen: string, uci: string): string | null {
    const [pos] = positionFromFen(fen);
    const move = parseUci(uci);
    if (!pos || !move || !pos.isLegal(move)) return null;
    pos.play(move);
    return makeFen(pos.toSetup());
}
