import type { DrawShape } from "@lichess-org/chessground/draw";
import { makeSquare, type NormalMove } from "chessops";
import { normalizeMove } from "chessops/chess";
import { makeFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { useEffect, useMemo, useState } from "react";
import {
  formatReviewInterval,
  getCardForReview,
  getNextReviewTimes,
  getStats,
  type PracticeData,
  updateCardPerformance,
} from "@/components/files/opening";
import { positionFromFen } from "@/utils/chessops";
import type { TreeNode } from "@/utils/treeReducer";
import { findFen } from "@/utils/treeReducer";
import { prepareDeck } from "../repertoires";
import { setDeck } from "../state";
import { scheduleSync, syncNow } from "../sync";
import { Board } from "./Board";

type Phase =
  | { kind: "waiting" }
  | { kind: "correct"; san: string; move: NormalMove }
  | { kind: "incorrect"; played: string; answer: NormalMove | null };

const GRADES: { grade: 1 | 2 | 3 | 4; label: string; className: string }[] = [
  { grade: 1, label: "Di nuovo", className: "again" },
  { grade: 2, label: "Difficile", className: "hard" },
  { grade: 3, label: "Bene", className: "good" },
  { grade: 4, label: "Facile", className: "easy" },
];

const PRACTICE_SYNC_DELAY = 15_000;

/** Moves (SAN) from the root to the node at `path`, as "1. e4 c5 2. Nf3". */
function lineTo(root: TreeNode, path: number[]): { text: string; last: TreeNode | null } {
  let node = root;
  const parts: string[] = [];
  for (const i of path) {
    const next = node.children[i];
    if (!next) break;
    const ply = next.halfMoves; // after the move
    const moveNumber = Math.ceil(ply / 2);
    if (ply % 2 === 1) parts.push(`${moveNumber}.`);
    else if (parts.length === 0) parts.push(`${moveNumber}...`);
    parts.push(next.san ?? "");
    node = next;
  }
  return { text: parts.join(" "), last: path.length > 0 ? node : null };
}

function arrow(move: NormalMove, brush: string): DrawShape {
  return { orig: makeSquare(move.from), dest: makeSquare(move.to), brush };
}

export function Practice({
  rel,
  game,
  name,
  onBack,
}: {
  rel: string;
  game: number;
  name: string;
  onBack: () => void;
}) {
  const prepared = useMemo(() => prepareDeck(rel, game), [rel, game]);
  const [deck, setLocalDeck] = useState<PracticeData | null>(prepared?.deck ?? null);
  const [mode, setMode] = useState<"due" | "all">("due");
  const [queue, setQueue] = useState<string[]>([]);
  const [currentFen, setCurrentFen] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "waiting" });
  const [session, setSession] = useState({ correct: 0, incorrect: 0 });

  // Sync when leaving the screen.
  useEffect(() => () => void syncNow().catch(() => {}), []);

  const save = (next: PracticeData) => {
    setLocalDeck(next);
    setDeck(rel, String(game), next);
    scheduleSync(PRACTICE_SYNC_DELAY);
  };

  const pickNext = (d: PracticeData, m: "due" | "all", q: string[]) => {
    setPhase({ kind: "waiting" });
    if (m === "all") {
      setCurrentFen(q[0] ?? null);
      setQueue(q);
    } else {
      setCurrentFen(getCardForReview(d.positions)?.fen ?? null);
    }
  };

  useEffect(() => {
    if (deck) pickNext(deck, "due", []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!prepared || !deck) {
    return (
      <div className="screen">
        <Header title={name} onBack={onBack} />
        <p className="empty">Impossibile leggere questo repertorio.</p>
      </div>
    );
  }

  const { pgn } = prepared;
  const stats = getStats(deck.positions);
  const index = currentFen ? deck.positions.findIndex((p) => p.fen === currentFen) : -1;
  const position = index >= 0 ? deck.positions[index] : null;
  const path = position ? findFen(position.fen, pgn.root) : [];
  const line = lineTo(pgn.root, path);
  const lastMove =
    line.last?.move && "from" in line.last.move
      ? ([makeSquare(line.last.move.from), makeSquare(line.last.move.to)] as [string, string])
      : undefined;

  function grade(g: 1 | 2 | 3 | 4) {
    if (!deck || index < 0) return;
    let next = deck;
    updateCardPerformance(
      (action) => {
        next = typeof action === "function" ? action(structuredClone(deck)) : action;
      },
      index,
      deck.positions[index].card,
      g,
    );
    save(next);
    pickNext(next, mode, queue);
  }

  function onMove(raw: NormalMove) {
    if (!position || phase.kind !== "waiting") return;
    const [pos] = positionFromFen(position.fen);
    if (!pos) return;
    const answerMove = parseSan(pos, position.answer) as NormalMove | undefined;
    let move: NormalMove = normalizeMove(pos, raw) as NormalMove;
    // Promotion: use the repertoire's piece when the squares match, otherwise a queen.
    const piece = pos.board.get(move.from);
    const rank = Math.floor(move.to / 8);
    if (piece?.role === "pawn" && (rank === 0 || rank === 7)) {
      const promotion =
        answerMove && answerMove.from === move.from && answerMove.to === move.to
          ? answerMove.promotion
          : "queen";
      move = { ...move, promotion };
    }
    if (!pos.isLegal(move)) {
      setPhase({ kind: "waiting" });
      return;
    }
    const san = makeSan(pos, move);
    if (san === position.answer) {
      setSession((s) => ({ ...s, correct: s.correct + 1 }));
      if (mode === "all") {
        setPhase({ kind: "correct", san, move });
        setTimeout(() => {
          const q = queue.slice(1);
          pickNext(deck!, "all", q);
        }, 600);
      } else {
        setPhase({ kind: "correct", san, move });
      }
    } else {
      setSession((s) => ({ ...s, incorrect: s.incorrect + 1 }));
      if (mode === "due") {
        // Same as the desktop app: a wrong move counts as "again".
        let next = deck!;
        updateCardPerformance(
          (action) => {
            next = typeof action === "function" ? action(structuredClone(deck!)) : action;
          },
          index,
          position.card,
          1,
        );
        save(next);
      }
      setPhase({ kind: "incorrect", played: san, answer: answerMove ?? null });
    }
  }

  function startAll() {
    const q = deck!.positions.map((p) => p.fen);
    setMode("all");
    pickNext(deck!, "all", q);
  }

  function startDue() {
    setMode("due");
    pickNext(deck!, "due", []);
  }

  let boardFen = position?.fen ?? deck.positions[0]?.fen ?? pgn.root.fen;
  let shapes: DrawShape[] = [];
  let boardLastMove = lastMove;
  if (position && phase.kind === "correct") {
    const [pos] = positionFromFen(position.fen);
    if (pos) {
      pos.play(phase.move);
      boardFen = makeFen(pos.toSetup());
      boardLastMove = [makeSquare(phase.move.from), makeSquare(phase.move.to)];
    }
  }
  if (position && phase.kind === "incorrect" && phase.answer) {
    shapes = [arrow(phase.answer, "green")];
  }

  const reviewTimes =
    position && phase.kind === "correct" && mode === "due"
      ? getNextReviewTimes(position.card)
      : null;

  return (
    <div className="screen practice">
      <Header title={name} onBack={onBack} />
      <div className="stats-row">
        <span className="pill due">{stats.due} da ripassare</span>
        <span className="pill new">{stats.unseen} nuove</span>
        <span className="pill">{stats.total} totali</span>
      </div>
      <Board
        fen={boardFen}
        orientation={pgn.orientation}
        lastMove={boardLastMove}
        shapes={shapes}
        interactive={!!position && phase.kind === "waiting"}
        onMove={onMove}
      />
      <div className="line">{position ? line.text || "Posizione iniziale" : ""}</div>

      <div className="panel">
        {!position && (
          <div className="done">
            {mode === "all" ? (
              <p>Ripasso completo finito.</p>
            ) : (
              <p>
                Niente da ripassare ora.
                {stats.nextDue && (
                  <>
                    <br />
                    Prossimo ripasso:{" "}
                    {stats.nextDue.toLocaleString("it-IT", {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </>
                )}
              </p>
            )}
            <div className="buttons">
              {mode === "all" ? (
                <button type="button" onClick={startDue}>
                  Torna al ripasso
                </button>
              ) : (
                <button type="button" onClick={startAll}>
                  Ripassa tutto il repertorio
                </button>
              )}
            </div>
          </div>
        )}

        {position && phase.kind === "waiting" && (
          <p className="hint">
            Gioca la mossa del tuo repertorio ({pgn.orientation === "white" ? "Bianco" : "Nero"}).
          </p>
        )}

        {position && phase.kind === "incorrect" && (
          <div className="result wrong">
            <p>
              <strong>{phase.played}</strong> non è la mossa del repertorio. La mossa giusta è{" "}
              <strong>{position.answer}</strong>.
            </p>
            <div className="buttons">
              <button
                type="button"
                className="primary"
                onClick={() =>
                  mode === "all" ? pickNext(deck, "all", queue.slice(1)) : pickNext(deck, "due", [])
                }
              >
                Avanti
              </button>
            </div>
          </div>
        )}

        {position && phase.kind === "correct" && reviewTimes && (
          <div className="result right">
            <p>
              <strong>{phase.san}</strong> — giusto! Quanto è stato facile?
            </p>
            <div className="grades">
              {GRADES.map(({ grade: g, label, className }) => (
                <button
                  key={g}
                  type="button"
                  className={`grade ${className}`}
                  onClick={() => grade(g)}
                >
                  <span>{label}</span>
                  <small>{formatReviewInterval(reviewTimes[g])}</small>
                </button>
              ))}
            </div>
          </div>
        )}

        {position && phase.kind === "correct" && mode === "all" && (
          <div className="result right">
            <p>
              <strong>{phase.san}</strong> — giusto!
            </p>
          </div>
        )}

        <p className="session">
          Sessione: {session.correct} giuste · {session.incorrect} sbagliate
          {mode === "all" && position ? ` · ${queue.length} rimaste` : ""}
        </p>
      </div>
    </div>
  );
}

export function Header({
  title,
  onBack,
  right,
}: {
  title: string;
  onBack?: () => void;
  right?: React.ReactNode;
}) {
  return (
    <header className="header">
      {onBack ? (
        <button type="button" className="icon" onClick={onBack} aria-label="Indietro">
          ‹
        </button>
      ) : (
        <span className="icon-spacer" />
      )}
      <h1>{title}</h1>
      <div className="header-right">{right}</div>
    </header>
  );
}
