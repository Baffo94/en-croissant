// Engine checks for the training exercises on the PC (the first local engine installed).

import { parseUci } from "chessops";
import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import { commands } from "@/bindings";
import type { LocalEngine } from "@/utils/engines";
import { clampCp, CP_CEILING } from "@/utils/gameReview";
import { pickEngine } from "../repertoires/checkRunner";

const ID = "training";

export type EngineLine = { uci: string[]; san: string[]; cp: number };

function uciOptions(engine: LocalEngine, multiPv: number) {
    return [
        ...(engine.settings ?? [])
            .filter((s) => s.name !== "MultiPV")
            .map((s) => ({ name: s.name, value: s.value?.toString() ?? "" })),
        { name: "MultiPV", value: String(multiPv) },
    ];
}

let engineCache: Promise<LocalEngine | null> | null = null;

export function trainingEngine(): Promise<LocalEngine | null> {
    engineCache ??= pickEngine();
    return engineCache;
}

/**
 * Analyses `fen` (MultiPV lines) and, for each of `moves`, the position after it.
 * Scores are from the point of view of the side to move in `fen`.
 */
export async function analyseCandidates(
    fen: string,
    moves: string[],
    { ms = 2000, multiPv = 3 }: { ms?: number; multiPv?: number } = {},
): Promise<{ lines: EngineLine[]; scores: Record<string, number>; engine: string } | null> {
    const engine = await trainingEngine();
    if (!engine) return null;
    const pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
    const sign = pos.turn === "white" ? 1 : -1;
    const scores: Record<string, number> = {};
    let lines: EngineLine[] = [];
    // One call per move: the start position (with its best lines) and the one after the move.
    const list = moves.length ? moves : [""];
    for (const uci of list) {
        const res = await commands.analyzeGame(
            ID,
            engine.path,
            { t: "Time", c: ms },
            {
                fen,
                moves: uci ? [uci] : [],
                annotateNovelties: false,
                referenceDb: null,
                reversed: false,
                evalCache: true,
                cloudEval: false,
            },
            uciOptions(engine, multiPv),
        );
        if (res.status !== "ok") throw new Error(String(res.error));
        if (lines.length === 0 && res.data[0]) {
            lines = res.data[0].best.map((b) => ({
                uci: b.uciMoves,
                san: b.sanMoves,
                cp: clampCp(b.score.value) * sign,
            }));
        }
        if (!uci) continue;
        const after = res.data[1]?.best[0];
        if (after) scores[uci] = clampCp(after.score.value) * sign;
        else {
            // No analysis after the move: the game is over (mate or draw) on the board.
            const next = pos.clone();
            const move = parseUci(uci);
            if (move) next.play(move);
            scores[uci] = next.isCheckmate() ? CP_CEILING : 0;
        }
    }
    return { lines, scores, engine: engine.name };
}

export function stopTrainingEngine() {
    commands.cancelAnalysis(ID).catch(() => {});
}
