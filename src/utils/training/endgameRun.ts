// Playing a theoretical endgame against the Lichess tablebases (perfect play with up to
// 7 pieces): after each of your moves the tablebase says whether you kept the result,
// and the opponent answers with the best defence.

import { makeUci, parseUci } from "chessops";
import { Chess } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import type { Endgame } from "./endgames";

export const TABLEBASE_URL = "https://tablebase.lichess.ovh/standard";

export type TbMove = {
    uci: string;
    san: string;
    /** Result for the side to move AFTER this move (so a winning move is a "loss"). */
    category: string;
    dtz?: number | null;
    dtm?: number | null;
};

export type TbPosition = {
    /** Result for the side to move. */
    category: string;
    dtz?: number | null;
    dtm?: number | null;
    checkmate?: boolean;
    stalemate?: boolean;
    insufficient_material?: boolean;
    /** Best move first for the side to move. */
    moves: TbMove[];
};

export type Probe = (fen: string) => Promise<TbPosition>;

export type Verdict = "win" | "draw" | "loss" | "unknown";

/** Practical result for the side to move (the 50-move rule counts: cursed wins are draws). */
export function verdict(category: string): Verdict {
    switch (category) {
        case "win":
        case "maybe-win":
            return "win";
        case "loss":
        case "maybe-loss":
            return "loss";
        case "draw":
        case "cursed-win":
        case "blessed-loss":
            return "draw";
        default:
            return "unknown";
    }
}

const flip = (v: Verdict): Verdict => (v === "win" ? "loss" : v === "loss" ? "win" : v);

/** A tablebase client with a cache (positions never change result). */
export function tablebaseProbe(fetchImpl: typeof fetch = fetch): Probe {
    const cache = new Map<string, TbPosition>();
    return async (fen: string) => {
        const known = cache.get(fen);
        if (known) return known;
        const res = await fetchImpl(`${TABLEBASE_URL}?fen=${encodeURIComponent(fen)}`);
        if (res.status === 429)
            throw new Error("Troppe richieste alla tablebase: riprova tra un minuto.");
        if (!res.ok) throw new Error(`Tablebase non raggiungibile (${res.status}).`);
        const data = (await res.json()) as TbPosition;
        cache.set(fen, data);
        return data;
    };
}

export type RunStatus = "playing" | "success" | "failed";

export type MoveOutcome = {
    status: RunStatus;
    /** Why the run ended (or a note while playing). */
    message?: string;
    /** The opponent's answer, already played. */
    reply?: { uci: string; san: string };
    /** When you went wrong: the move that kept the result. */
    better?: string;
};

const positionKey = (fen: string) => fen.split(" ").slice(0, 4).join(" ");

/** One attempt at an endgame exercise. */
export class EndgameRun {
    readonly exercise: Endgame;
    readonly user: "white" | "black";
    pos: Chess;
    /** SAN moves played so far (both sides). */
    readonly moves: string[] = [];
    status: RunStatus = "playing";
    private userMoves = 0;
    private seen = new Map<string, number>();
    private readonly probe: Probe;

    constructor(exercise: Endgame, probe: Probe) {
        this.exercise = exercise;
        this.probe = probe;
        this.pos = Chess.fromSetup(parseFen(exercise.fen).unwrap()).unwrap();
        this.user = this.pos.turn;
        this.remember();
    }

    get fen(): string {
        return makeFen(this.pos.toSetup());
    }

    private remember(): number {
        const key = positionKey(this.fen);
        const n = (this.seen.get(key) ?? 0) + 1;
        this.seen.set(key, n);
        return n;
    }

    /** The tablebase result of the start position for you (to warn if it is not the goal). */
    async startVerdict(): Promise<Verdict> {
        return verdict((await this.probe(this.exercise.fen)).category);
    }

    private opponentHasOnlyKing(): boolean {
        const them = this.user === "white" ? "black" : "white";
        return this.pos.board[them].size() === 1;
    }

    private async better(beforeFen: string): Promise<string | undefined> {
        try {
            return (await this.probe(beforeFen)).moves[0]?.san;
        } catch {
            return undefined;
        }
    }

    private fail(message: string, better?: string): MoveOutcome {
        this.status = "failed";
        return { status: "failed", message, better };
    }

    private succeed(message: string, reply?: MoveOutcome["reply"]): MoveOutcome {
        this.status = "success";
        return { status: "success", message, reply };
    }

    /** Plays your move (UCI) and, if the run goes on, the tablebase's answer. */
    async play(uci: string): Promise<MoveOutcome> {
        if (this.status !== "playing") return { status: this.status };
        const move = parseUci(uci);
        if (!move || !this.pos.isLegal(move))
            return { status: "playing", message: "Mossa illegale" };
        const ex = this.exercise;
        const beforeFen = this.fen;
        const san = makeSan(this.pos, move);
        const promotes = "promotion" in move && !!move.promotion;
        this.pos.play(move);
        this.moves.push(san);
        this.userMoves++;
        const repeated = this.remember() >= 3;

        // Game over on the board.
        if (this.pos.isCheckmate()) return this.succeed("Scacco matto!");
        if (this.pos.isStalemate())
            return ex.goal === "draw"
                ? this.succeed("Stallo: patta raggiunta.")
                : this.fail("Stallo! La vittoria è sfumata.", await this.better(beforeFen));
        if (this.pos.isInsufficientMaterial())
            return ex.goal === "draw"
                ? this.succeed("Materiale insufficiente: patta raggiunta.")
                : this.fail("Non resta materiale per vincere.", await this.better(beforeFen));

        const after = await this.probe(this.fen);
        const mine = flip(verdict(after.category));
        if (ex.goal === "win" && mine !== "win") {
            return this.fail(
                mine === "draw" ? "Questa mossa lascia la patta." : "Questa mossa perde.",
                await this.better(beforeFen),
            );
        }
        if (ex.goal === "draw" && mine === "loss")
            return this.fail("Questa mossa perde.", await this.better(beforeFen));

        if (ex.goal === "win") {
            if (ex.stop === "promotion" && promotes) return this.succeed("Pedone promosso: vinto!");
            if (ex.stop === "capture" && this.opponentHasOnlyKing())
                return this.succeed("All'avversario resta solo il re: vinto!");
            if (repeated) return this.fail("Triplice ripetizione: così è patta.");
            if (this.userMoves >= (ex.limit ?? 40))
                return this.fail("Troppe mosse: la vittoria va trovata più in fretta.");
        } else {
            if (repeated) return this.succeed("Triplice ripetizione: patta raggiunta.");
            if (this.userMoves >= (ex.hold ?? 12)) return this.succeed("Hai tenuto la patta!");
        }

        // The tablebase defends (or attacks) with its best move.
        const best = after.moves[0];
        if (!best) return { status: "playing" };
        const reply = parseUci(best.uci);
        if (!reply) return { status: "playing" };
        const replySan = makeSan(this.pos, reply);
        this.pos.play(reply);
        this.moves.push(replySan);
        const answer = { uci: makeUci(reply), san: replySan };
        const repeatedAfter = this.remember() >= 3;
        if (this.pos.isCheckmate())
            return { ...this.fail("Scacco matto: hai perso."), reply: answer };
        if (this.pos.isStalemate() || this.pos.isInsufficientMaterial()) {
            return ex.goal === "draw"
                ? this.succeed("Patta raggiunta.", answer)
                : { ...this.fail("La partita è finita patta."), reply: answer };
        }
        if (repeatedAfter) {
            return ex.goal === "draw"
                ? this.succeed("Triplice ripetizione: patta raggiunta.", answer)
                : { ...this.fail("Triplice ripetizione: così è patta."), reply: answer };
        }
        return { status: "playing", reply: answer };
    }
}
