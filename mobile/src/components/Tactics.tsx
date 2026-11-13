import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Key } from "@lichess-org/chessground/types";
import { makeUci, type NormalMove } from "chessops";
import { makeSan } from "chessops/san";
import { useEffect, useMemo, useState } from "react";
import { positionFromFen } from "@/utils/chessops";
import { planSession } from "@/utils/training/srs";
import { isGoodAnswer, type Tactic } from "@/utils/training/tactics";
import { fenAfter } from "../engine";
import { scheduleSync } from "../sync";
import { recordExercise, useTraining } from "../training";
import { evaluateAfter, stopTrainingEngine } from "../trainingEngine";
import { Board } from "./Board";
import { Header } from "./Practice";

const TRAINING_SYNC_DELAY = 15_000;
export const TACTICS_PER_DAY = 10;

/** "+0.8", "−1.2" */
export function pawns(cp: number): string {
  const v = Math.round(cp / 10) / 10;
  if (v === 0) return "0.0";
  return v > 0 ? `+${v.toFixed(1)}` : `−${(-v).toFixed(1)}`;
}

type Phase =
  | { kind: "waiting" }
  | { kind: "checking"; uci: string; san: string }
  | { kind: "right"; uci: string; san: string; exact: boolean }
  | { kind: "wrong"; uci: string; san: string; cp: number | null; error?: string };

const arrow = (uci: string, brush: string): DrawShape => ({
  orig: uci.slice(0, 2) as Key,
  dest: uci.slice(2, 4) as Key,
  brush,
});

function withPromotion(fen: string, move: NormalMove): NormalMove {
  const [pos] = positionFromFen(fen);
  const rank = Math.floor(move.to / 8);
  if (pos?.board.get(move.from)?.role === "pawn" && (rank === 0 || rank === 7))
    return { ...move, promotion: "queen" };
  return move;
}

const sideName = (c: "white" | "black") => (c === "white" ? "il Bianco" : "il Nero");

export function Tactics({ onBack }: { onBack: () => void }) {
  const training = useTraining();
  const pack = training?.pack ?? null;
  const byId = useMemo(() => new Map((pack?.tactics ?? []).map((t) => [t.id, t])), [pack]);
  // The session is fixed when the screen opens.
  const [queue, setQueue] = useState<string[]>(() =>
    pack
      ? planSession(
          pack.tactics.map((t) => t.id),
          training?.progress.tactics ?? {},
          TACTICS_PER_DAY,
        ).ids
      : [],
  );
  const [phase, setPhase] = useState<Phase>({ kind: "waiting" });
  const [score, setScore] = useState({ right: 0, done: 0 });
  const tactic: Tactic | undefined = queue.length ? byId.get(queue[0]) : undefined;

  useEffect(() => () => stopTrainingEngine(), []);

  const record = (t: Tactic, ok: boolean) => {
    recordExercise("tactics", t.id, ok ? "good" : "again");
    scheduleSync(TRAINING_SYNC_DELAY);
    setScore((s) => ({ right: s.right + (ok ? 1 : 0), done: s.done + 1 }));
  };

  const onMove = async (raw: NormalMove) => {
    if (!tactic || phase.kind !== "waiting") return;
    const move = withPromotion(tactic.fen, raw);
    const [pos] = positionFromFen(tactic.fen);
    if (!pos || !pos.isLegal(move)) return;
    const uci = makeUci(move);
    const san = makeSan(pos, move);
    if (uci === tactic.bestUci || san === tactic.best) {
      setPhase({ kind: "right", uci, san, exact: true });
      record(tactic, true);
      return;
    }
    setPhase({ kind: "checking", uci, san });
    const after = fenAfter(tactic.fen, uci);
    try {
      if (!after) throw new Error("Mossa non valida.");
      const cp = await evaluateAfter(after, tactic.color);
      const ok = isGoodAnswer(tactic.evalBest, cp);
      setPhase(ok ? { kind: "right", uci, san, exact: false } : { kind: "wrong", uci, san, cp });
      record(tactic, ok);
    } catch (e) {
      setPhase({
        kind: "wrong",
        uci,
        san,
        cp: null,
        error: e instanceof Error ? e.message : String(e),
      });
      record(tactic, false);
    }
  };

  const next = () => {
    setQueue((q) => {
      const [first, ...rest] = q;
      // A missed exercise comes back once at the end of the session.
      return phase.kind === "wrong" && !rest.includes(first) ? [...rest, first] : rest;
    });
    setPhase({ kind: "waiting" });
  };

  const shapes = useMemo<DrawShape[]>(() => {
    if (!tactic) return [];
    if (phase.kind === "right" || phase.kind === "wrong") {
      const list = [arrow(tactic.bestUci, "green")];
      if (phase.kind === "wrong") list.push(arrow(phase.uci, "red"));
      return list;
    }
    return [];
  }, [tactic, phase]);

  const total = pack?.tactics.length ?? 0;

  return (
    <div className="screen practice">
      <Header title="Tattiche" onBack={onBack} />
      {!pack || total === 0 ? (
        <div className="empty">
          <p>Nessun esercizio.</p>
          <p className="small">
            Le tattiche nascono dagli errori delle tue partite analizzate sul PC (pagina
            Allenamento): poi sincronizza.
          </p>
        </div>
      ) : !tactic ? (
        <div className="panel">
          <div className="done">
            <p>
              {score.done > 0
                ? `Sessione finita: ${score.right} giuste su ${score.done}.`
                : "Per oggi non ci sono tattiche da fare."}
            </p>
            <div className="buttons">
              <button type="button" className="primary" onClick={onBack}>
                Torna indietro
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="stats-row">
            <span className={`pill ${tactic.kind === "missed" ? "new" : "due"}`}>
              {tactic.kind === "missed" ? "Occasione persa" : "Tuo errore"}
            </span>
            <span className="pill">{queue.length} in coda</span>
          </div>
          <Board
            fen={tactic.fen}
            orientation={tactic.color}
            shapes={shapes}
            interactive={phase.kind === "waiting"}
            onMove={(m) => void onMove(m)}
          />
          <div className="panel">
            <p className="meta">
              Contro {tactic.opponent}, {new Date(tactic.date).toLocaleDateString("it-IT")}, mossa{" "}
              {tactic.moveLabel}
            </p>
            {phase.kind === "waiting" && (
              <p className="hint">Muove {sideName(tactic.color)}: trova la mossa migliore.</p>
            )}
            {phase.kind === "checking" && (
              <p className="hint">
                <strong>{phase.san}</strong>: controllo col motore…
              </p>
            )}
            {phase.kind === "right" && (
              <div className="result right">
                <p>
                  {phase.exact ? (
                    <>
                      <strong>{phase.san}</strong> — giusto!
                    </>
                  ) : (
                    <>
                      Va bene anche <strong>{phase.san}</strong> (il motore voleva{" "}
                      <strong>{tactic.best}</strong>).
                    </>
                  )}
                </p>
              </div>
            )}
            {phase.kind === "wrong" && (
              <div className="result wrong">
                <p>
                  <strong>{phase.san}</strong> non basta
                  {phase.cp !== null ? ` (${pawns(phase.cp)})` : ""}: la mossa era{" "}
                  <strong>{tactic.best}</strong> ({pawns(tactic.evalBest)}).
                </p>
                {phase.error && <p className="small">{phase.error}</p>}
              </div>
            )}
            {(phase.kind === "right" || phase.kind === "wrong") && (
              <>
                <p className="small">
                  In partita hai giocato {tactic.played} ({pawns(tactic.evalPlayed)}).
                </p>
                <div className="buttons">
                  <button type="button" className="primary" onClick={next}>
                    Avanti
                  </button>
                </div>
              </>
            )}
            <p className="session">
              Sessione: {score.right} giuste · {score.done - score.right} sbagliate
            </p>
          </div>
        </>
      )}
    </div>
  );
}
