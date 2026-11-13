import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Key } from "@lichess-org/chessground/types";
import { makeUci, type NormalMove } from "chessops";
import { useEffect, useMemo, useRef, useState } from "react";
import { positionFromFen } from "@/utils/chessops";
import {
  EndgameRun,
  type MoveOutcome,
  type RunStatus,
  tablebaseProbe,
  type Verdict,
} from "@/utils/training/endgameRun";
import { CHAPTERS, type Endgame, ENDGAMES, endgameById } from "@/utils/training/endgames";
import { numberedMoves } from "@/utils/training/notation";
import { isDue, isNew, type Outcome } from "@/utils/training/srs";
import { useBackHandler } from "../back";
import { fenAfter } from "../engine";
import { scheduleSync } from "../sync";
import { recordExercise, useTraining } from "../training";
import { Board } from "./Board";
import { Header } from "./Practice";

const TRAINING_SYNC_DELAY = 15_000;
const probe = tablebaseProbe((input, init) => fetch(input, init));

export function goalText(ex: Endgame): string {
  if (ex.goal === "draw") return `Tieni la patta per ${ex.hold ?? 12} mosse`;
  const n = ex.limit ?? 40;
  switch (ex.stop ?? "mate") {
    case "promotion":
      return `Vinci: promuovi entro ${n} mosse`;
    case "capture":
      return `Vinci il materiale entro ${n} mosse`;
    default:
      return `Matta entro ${n} mosse`;
  }
}

const VERDICT_NAME: Record<Verdict, string> = {
  win: "vinta",
  draw: "patta",
  loss: "persa",
  unknown: "sconosciuta",
};

const squares = (uci: string): [string, string] => [uci.slice(0, 2), uci.slice(2, 4)];

function withPromotion(fen: string, move: NormalMove): NormalMove {
  const [pos] = positionFromFen(fen);
  const rank = Math.floor(move.to / 8);
  if (pos?.board.get(move.from)?.role === "pawn" && (rank === 0 || rank === 7))
    return { ...move, promotion: "queen" };
  return move;
}

function EndgamePlay({ ids, onBack }: { ids: string[]; onBack: () => void }) {
  useBackHandler(onBack);
  const [index, setIndex] = useState(0);
  const exercise = endgameById(ids[index]);
  const [results, setResults] = useState<Record<string, boolean>>({});

  if (!exercise) {
    const ok = Object.values(results).filter(Boolean).length;
    return (
      <div className="screen practice">
        <Header title="Finali" onBack={onBack} />
        <div className="panel">
          <div className="done">
            <p>
              Finito: {ok} risolti su {Object.keys(results).length}.
            </p>
            <div className="buttons">
              <button type="button" className="primary" onClick={onBack}>
                Torna all'elenco
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <EndgameBoard
      key={exercise.id}
      exercise={exercise}
      position={ids.length > 1 ? `${index + 1}/${ids.length}` : null}
      done={exercise.id in results}
      last={index === ids.length - 1}
      onRecorded={(ok) => setResults((r) => ({ ...r, [exercise.id]: ok }))}
      onNext={() => setIndex((i) => i + 1)}
      onBack={onBack}
    />
  );
}

function EndgameBoard({
  exercise,
  position,
  done,
  last,
  onRecorded,
  onNext,
  onBack,
}: {
  exercise: Endgame;
  position: string | null;
  done: boolean;
  last: boolean;
  onRecorded: (ok: boolean) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const runRef = useRef<EndgameRun | null>(null);
  if (runRef.current === null) runRef.current = new EndgameRun(exercise, probe);
  const user = exercise.fen.split(" ")[1] === "b" ? "black" : "white";
  const [fen, setFen] = useState(exercise.fen);
  const [moves, setMoves] = useState<string[]>([]);
  const [status, setStatus] = useState<RunStatus>("playing");
  const [lastMove, setLastMove] = useState<[string, string] | undefined>();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<MoveOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startCheck, setStartCheck] = useState<Verdict | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [hintUsed, setHintUsed] = useState(false);
  const [attempt, setAttempt] = useState(1);
  const [showIdea, setShowIdea] = useState(true);
  const recorded = useRef(false);

  useEffect(() => {
    let live = true;
    runRef.current
      ?.startVerdict()
      .then((v) => live && setStartCheck(v))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);

  const record = (ok: boolean) => {
    if (recorded.current) return;
    recorded.current = true;
    const result: Outcome = !ok ? "again" : hintUsed || attempt > 1 ? "hard" : "good";
    recordExercise("endgames", exercise.id, result);
    scheduleSync(TRAINING_SYNC_DELAY);
    onRecorded(ok);
  };

  const restart = () => {
    runRef.current = new EndgameRun(exercise, probe);
    setFen(exercise.fen);
    setMoves([]);
    setStatus("playing");
    setLastMove(undefined);
    setOutcome(null);
    setError(null);
    setHint(null);
    setBusy(false);
    setAttempt((a) => a + 1);
  };

  const onMove = async (raw: NormalMove) => {
    const run = runRef.current;
    if (!run || busy || run.status !== "playing") return;
    const uci = makeUci(withPromotion(fen, raw));
    const shown = fenAfter(fen, uci);
    if (!shown) return;
    setFen(shown);
    setLastMove(squares(uci));
    setHint(null);
    setShowIdea(false);
    setBusy(true);
    setError(null);
    try {
      const res = await run.play(uci);
      setOutcome(res);
      setFen(run.fen);
      setMoves([...run.moves]);
      setStatus(run.status);
      if (res.reply) setLastMove(squares(res.reply.uci));
      if (res.status !== "playing") record(res.status === "success");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMoves([...run.moves]);
    } finally {
      setBusy(false);
    }
  };

  const showHint = async () => {
    try {
      const best = (await probe(fen)).moves[0];
      if (best) {
        setHint(best.uci);
        setHintUsed(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const turn = fen.split(" ")[1] === "b" ? "black" : "white";
  const finished = status !== "playing";
  const stuck = !!error && !finished && turn !== user;
  const interactive = !busy && !finished && !stuck && turn === user;
  const shapes = useMemo<DrawShape[]>(
    () =>
      hint ? [{ orig: hint.slice(0, 2) as Key, dest: hint.slice(2, 4) as Key, brush: "blue" }] : [],
    [hint],
  );
  const mismatch = startCheck !== null && startCheck !== "unknown" && startCheck !== exercise.goal;

  return (
    <div className="screen practice">
      <Header
        title={exercise.title}
        onBack={onBack}
        right={position ? <span className="header-count">{position}</span> : undefined}
      />
      <div className="stats-row">
        <span className={`pill ${exercise.goal === "win" ? "new" : "due"}`}>
          {goalText(exercise)}
        </span>
        <span className="pill">Giochi col {user === "white" ? "Bianco" : "Nero"}</span>
      </div>
      <Board
        fen={fen}
        orientation={user}
        lastMove={lastMove}
        shapes={shapes}
        interactive={interactive}
        onMove={(m) => void onMove(m)}
      />
      <div className="panel">
        {moves.length > 0 && <p className="line">{numberedMoves(exercise.fen, moves)}</p>}
        {showIdea ? (
          <p className="hint idea-text">{exercise.idea}</p>
        ) : (
          <button type="button" className="link-btn" onClick={() => setShowIdea(true)}>
            Mostra l'idea
          </button>
        )}
        {mismatch && (
          <p className="result-note warn">
            La tablebase dice che questa posizione è {VERDICT_NAME[startCheck!]}: l'esercizio è
            sbagliato, segnalamelo.
          </p>
        )}
        {busy && <p className="hint dim">La tablebase risponde…</p>}
        {error && <p className="result-note warn">{error}</p>}
        {outcome?.status === "playing" && outcome.message && (
          <p className="result-note warn">{outcome.message}</p>
        )}
        {outcome?.status === "success" && (
          <div className="result right">
            <p>
              <strong>{outcome.message}</strong>
            </p>
          </div>
        )}
        {outcome?.status === "failed" && (
          <div className="result wrong">
            <p>
              <strong>{outcome.message}</strong>
              {outcome.better && (
                <>
                  {" "}
                  La mossa giusta era <strong>{outcome.better}</strong>.
                </>
              )}
            </p>
          </div>
        )}
        <div className="buttons">
          {!finished && !stuck && (
            <button type="button" disabled={!interactive} onClick={() => void showHint()}>
              Suggerimento
            </button>
          )}
          {(finished || stuck || moves.length > 0) && (
            <button type="button" onClick={restart}>
              Riprova
            </button>
          )}
          {(position || finished) && (
            <button type="button" className={done ? "primary" : ""} onClick={onNext}>
              {last ? "Fine" : done ? "Avanti" : "Salta"}
            </button>
          )}
        </div>
        {hintUsed && !finished && (
          <p className="session">Con un suggerimento l'esercizio torna prima.</p>
        )}
      </div>
    </div>
  );
}

export function Endgames({ onBack }: { onBack: () => void }) {
  const progress = useTraining()?.progress.endgames ?? {};
  const [playing, setPlaying] = useState<string[] | null>(null);
  const due = ENDGAMES.filter((e) => isDue(progress[e.id])).map((e) => e.id);

  if (playing) return <EndgamePlay ids={playing} onBack={() => setPlaying(null)} />;

  return (
    <div className="screen">
      <Header title="Finali" onBack={onBack} />
      <p className="intro">
        I finali da sapere contro le tablebase di Lichess: l'avversario difende alla perfezione e
        ogni tua mossa viene controllata. Serve internet.
      </p>
      {due.length > 0 && (
        <div className="summary-row">
          <p className="summary">
            {due.length === 1 ? "1 finale" : `${due.length} finali`} da ripassare
          </p>
          <button type="button" className="primary" onClick={() => setPlaying(due)}>
            Ripassa
          </button>
        </div>
      )}
      {CHAPTERS.map((chapter) => {
        const list = ENDGAMES.filter((e) => e.chapter === chapter.id);
        const solved = list.filter((e) => progress[e.id]?.history.some((a) => a.ok)).length;
        return (
          <section key={chapter.id}>
            <div className="chapter-head">
              <h2 className="section-title">
                {chapter.title}{" "}
                <span className="chapter-count">
                  {solved}/{list.length}
                </span>
              </h2>
              <button
                type="button"
                className="link-btn"
                onClick={() => setPlaying(list.map((e) => e.id))}
              >
                Gioca tutto
              </button>
            </div>
            <ul className="list">
              {list.map((ex) => {
                const p = progress[ex.id];
                const last = p?.history.at(-1);
                return (
                  <li key={ex.id}>
                    <button type="button" className="item" onClick={() => setPlaying([ex.id])}>
                      <span className="item-main">
                        <span className="item-name">{ex.title}</span>
                        <span className="item-folder">{goalText(ex)}</span>
                      </span>
                      <span className="item-stats">
                        {isNew(p) ? (
                          <span className="pill new">nuovo</span>
                        ) : isDue(p) ? (
                          <span className="pill due">da ripassare</span>
                        ) : (
                          <span className={`pill ${last?.ok ? "ok" : "ko"}`}>
                            {new Date(p!.card.due).toLocaleDateString("it-IT", {
                              day: "numeric",
                              month: "short",
                            })}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
