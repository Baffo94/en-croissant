import { makeUci } from "chessops";
import { Chess } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import { describe, expect, test } from "vitest";
import { EndgameRun, type Probe, type TbPosition, verdict } from "../endgameRun";
import { CHAPTERS, ENDGAMES } from "../endgames";

function legalMoves(fen: string) {
    const pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
    const out: { uci: string; san: string }[] = [];
    for (const [from, dests] of pos.allDests()) {
        for (const to of dests) {
            const move = { from, to };
            out.push({ uci: makeUci(move), san: makeSan(pos, move) });
        }
    }
    return out;
}

/** A fake tablebase: the side with more material wins (or `draw` everywhere). */
function fakeProbe(rule: (fen: string) => string): Probe & { calls: string[] } {
    const calls: string[] = [];
    const probe = (async (fen: string): Promise<TbPosition> => {
        calls.push(fen);
        const category = rule(fen);
        const moves = legalMoves(fen).map((m) => ({ ...m, category: "draw" }));
        return { category, moves };
    }) as Probe & { calls: string[] };
    probe.calls = calls;
    return probe;
}

describe("endgame catalogue", () => {
    test("every position is legal, playable and within 7 pieces", () => {
        const ids = new Set<string>();
        for (const e of ENDGAMES) {
            expect(ids.has(e.id), e.id).toBe(false);
            ids.add(e.id);
            expect(CHAPTERS.some((c) => c.id === e.chapter)).toBe(true);
            const setup = parseFen(e.fen).unwrap();
            const pos = Chess.fromSetup(setup).unwrap();
            expect(pos.board.occupied.size(), e.id).toBeLessThanOrEqual(7);
            expect(pos.isEnd(), e.id).toBe(false);
            expect(makeFen(pos.toSetup())).toBe(e.fen);
            if (e.goal === "win") expect(e.stop, e.id).toBeDefined();
        }
        expect(ENDGAMES.length).toBeGreaterThanOrEqual(20);
    });

    test("tablebase categories as practical results", () => {
        expect(verdict("win")).toBe("win");
        expect(verdict("cursed-win")).toBe("draw");
        expect(verdict("blessed-loss")).toBe("draw");
        expect(verdict("maybe-loss")).toBe("loss");
        expect(verdict("???")).toBe("unknown");
    });
});

describe("EndgameRun", () => {
    const twoRooks = ENDGAMES.find((e) => e.id === "mate-two-rooks")!;
    const whiteWins = (fen: string) => (fen.split(" ")[1] === "w" ? "win" : "loss");

    test("mate with two rooks against the tablebase defence", async () => {
        const run = new EndgameRun(twoRooks, fakeProbe(whiteWins));
        expect(run.user).toBe("white");
        expect(await run.startVerdict()).toBe("win");
        const first = await run.play("h1h7");
        expect(first.status).toBe("playing");
        expect(first.reply).toBeDefined();
        const second = await run.play("a1a8");
        expect(second).toMatchObject({ status: "success", message: "Scacco matto!" });
    });

    test("a move that throws the win away fails and shows the right one", async () => {
        const probe = fakeProbe((fen) => (fen.includes("R3K1R1") ? "draw" : whiteWins(fen)));
        const run = new EndgameRun(twoRooks, probe);
        // After Rg1 our fake tablebase calls the position a draw.
        const out = await run.play("h1g1");
        expect(out.status).toBe("failed");
        expect(out.message).toBe("Questa mossa lascia la patta.");
        expect(out.better).toBeDefined();
        expect(await run.play("g1g8")).toEqual({ status: "failed" });
    });

    test("holding a draw for the required moves", async () => {
        const ex = ENDGAMES.find((e) => e.id === "rooks-philidor")!;
        const run = new EndgameRun(
            ex,
            fakeProbe(() => "draw"),
        );
        expect(run.user).toBe("black");
        let last = { status: "playing" as string };
        // Shuffle the rook along the sixth rank.
        const shuffle = ["b6c6", "c6b6"];
        for (let i = 0; i < 15 && last.status === "playing"; i++) {
            const options = legalMoves(run.fen).map((m) => m.uci);
            const move = shuffle.find((m) => options.includes(m)) ?? options[0];
            last = await run.play(move);
        }
        expect(last.status).toBe("success");
    });

    test("illegal moves are refused", async () => {
        const run = new EndgameRun(twoRooks, fakeProbe(whiteWins));
        expect(await run.play("e1e3")).toEqual({ status: "playing", message: "Mossa illegale" });
        expect(run.moves).toEqual([]);
    });
});
