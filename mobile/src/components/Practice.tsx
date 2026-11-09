import type { DrawShape } from "@lichess-org/chessground/draw";
import { makeSquare, type NormalMove } from "chessops";
import { normalizeMove } from "chessops/chess";
import { makeFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  formatReviewInterval,
  getNextReviewTimes,
  failedFens,
  getStats,
  isDue,
  type PracticeData,
  updateCardPerformance,
} from "@/components/files/opening";
import { positionFromFen } from "@/utils/chessops";
import type { PgnGame } from "@/utils/pgnTree";
import type { TreeNode } from "@/utils/treeReducer";
import { findFen } from "@/utils/treeReducer";
import { prepareDeck } from "../repertoires";
import { addNote, setDeck, setRepertoirePaused, useAppState } from "../state";
import { scheduleSync, syncNow } from "../sync";
import { Analysis } from "./Analysis";
import { Board } from "./Board";
import { NoteEditor, NotesHere } from "./NoteEditor";

type Phase =
  | { kind: "waiting" }
  | { kind: "correct"; san: string; move: NormalMove }
  | { kind: "incorrect"; played: string; playedFen: string; answer: NormalMove | null };

const GRADES: { grade: 1 | 2 | 3 | 4; label: string; className: string }[] = [
  { grade: 1, label: "Di nuovo", className: "again" },
  { grade: 2, label: "Difficile", className: "hard" },
  { grade: 3, label: "Bene", className: "good" },
  { grade: 4, label: "Facile", className: "easy" },
];

const PRACTICE_SYNC_DELAY = 15_000;
const PAUSE_SYNC_DELAY = 3_000;

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

export type PracticeSource = { rel: string; game: number; name: string };

type Item = { key: string; fen: string };

const keyOf = (source: PracticeSource) => `${source.rel}#${source.game}`;

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const NAG_TEXT: Record<string, string> = {
  "!!": "!!",
  "!": "!",
  "!?": "!?",
  "?!": "?!",
  "?": "?",
  "??": "??",
};

/** "Bc4!" — SAN followed by the move symbols written in the PGN. */
function withSymbols(node: TreeNode | undefined, san: string): string {
  const symbols = (node?.annotations ?? []).map((a) => NAG_TEXT[a] ?? "").join("");
  return `${san}${symbols}`;
}

function Notes({ items }: { items: { label: string; text: string }[] }) {
  const visible = items.filter((i) => i.text.trim());
  if (visible.length === 0) return null;
  return (
    <div className="notes">
      {visible.map((item) => (
        <p key={item.label}>
          <span className="notes-label">{item.label}</span> {item.text}
        </p>
      ))}
    </div>
  );
}

/**
 * Practice session. With one source it trains a single repertoire (in the PGN's order);
 * with `mixed` it shuffles the due positions of every source ("Allena tutto").
 */
export function Practice({
  sources,
  title,
  mixed = false,
  onBack,
}: {
  sources: PracticeSource[];
  title: string;
  mixed?: boolean;
  onBack: () => void;
}) {
  const prepared = useMemo(() => {
    const result: Record<string, { source: PracticeSource; pgn: PgnGame }> = {};
    const decks: Record<string, PracticeData> = {};
    for (const source of sources) {
      const p = prepareDeck(source.rel, source.game);
      if (!p) continue;
      result[keyOf(source)] = { source, pgn: p.pgn };
      decks[keyOf(source)] = p.deck;
    }
    return { sources: result, decks };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [decks, setDecks] = useState<Record<string, PracticeData>>(prepared.decks);
  // Latest decks, also right after a rating (state updates are asynchronous).
  const decksRef = useRef(decks);
  const [mode, setMode] = useState<"due" | "all">("due");
  const [queue, setQueue] = useState<Item[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "waiting" });
  const [session, setSession] = useState({ correct: 0, incorrect: 0 });
  /** Ply shown while browsing the moves that led to the position (null = live). */
  const [viewPly, setViewPly] = useState<number | null>(null);
  const [writingNote, setWritingNote] = useState(false);
  const [analysis, setAnalysis] = useState<{
    moves: string[];
    comments: string[];
    ply: number;
  } | null>(null);

  // Sync when leaving the screen.
  useEffect(() => () => void syncNow().catch(() => {}), []);

  /** Due positions (and new ones) of every source, shuffled when mixing repertoires. */
  const dueItems = (all: Record<string, PracticeData>): Item[] => {
    const now = new Date();
    const items: Item[] = [];
    for (const [key, deck] of Object.entries(all)) {
      const failed = failedFens(deck.logs);
      for (const p of deck.positions)
        if (isDue(p.card, now, failed.has(p.fen))) items.push({ key, fen: p.fen });
    }
    return mixed ? shuffle(items) : items;
  };

  const advance = (all: Record<string, PracticeData>, m: "due" | "all", rest: Item[]) => {
    setPhase({ kind: "waiting" });
    setWritingNote(false);
    setViewPly(null);
    // In review mode, positions answered "again" come back once they are due.
    setQueue(rest.length > 0 || m === "all" ? rest : dueItems(all));
  };

  useEffect(() => {
    advance(decks, "due", []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const singleRel = sources.length === 1 ? sources[0].rel : null;
  const paused = useAppState((s) => (singleRel ? s.pauses?.[singleRel]?.paused === true : false));
  const keys = Object.keys(prepared.sources);
  if (keys.length === 0) {
    return (
      <div className="screen">
        <Header title={title} onBack={onBack} />
        <p className="empty">Impossibile leggere questo repertorio.</p>
      </div>
    );
  }

  const allPositions = Object.values(decks).flatMap((d) => d.positions);
  const stats = getStats(
    allPositions,
    Object.values(decks).flatMap((d) => d.logs),
  );
  const current = queue[0];
  const currentSource = current ? prepared.sources[current.key] : prepared.sources[keys[0]];
  const pgn = currentSource.pgn;
  const deck = current ? decks[current.key] : undefined;
  const index = current && deck ? deck.positions.findIndex((p) => p.fen === current.fen) : -1;
  const position = deck && index >= 0 ? deck.positions[index] : null;
  const path = position ? findFen(position.fen, pgn.root) : [];
  const line = lineTo(pgn.root, path);
  const lastMove =
    line.last?.move && "from" in line.last.move
      ? ([makeSquare(line.last.move.from), makeSquare(line.last.move.to)] as [string, string])
      : undefined;

  const save = (key: string, next: PracticeData) => {
    const source = prepared.sources[key].source;
    const all = { ...decksRef.current, [key]: next };
    decksRef.current = all;
    setDecks(all);
    setDeck(source.rel, String(source.game), next);
    scheduleSync(PRACTICE_SYNC_DELAY);
    return all;
  };

  const rate = (g: 1 | 2 | 3 | 4) => {
    if (!current || !deck || index < 0) return decks;
    let next = deck;
    updateCardPerformance(
      (action) => {
        next = typeof action === "function" ? action(structuredClone(deck)) : action;
      },
      index,
      deck.positions[index].card,
      g,
    );
    return save(current.key, next);
  };

  function grade(g: 1 | 2 | 3 | 4) {
    const all = rate(g);
    advance(all, mode, queue.slice(1));
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
      setPhase({ kind: "correct", san, move });
      if (mode === "all") {
        const rest = queue.slice(1);
        setTimeout(() => advance(decksRef.current, "all", rest), 600);
      }
    } else {
      setSession((s) => ({ ...s, incorrect: s.incorrect + 1 }));
      // Same as the desktop app: a wrong move counts as "again".
      if (mode === "due") rate(1);
      pos.play(move);
      setPhase({
        kind: "incorrect",
        played: san,
        playedFen: makeFen(pos.toSetup()),
        answer: answerMove ?? null,
      });
    }
  }

  function startAll() {
    const items: Item[] = [];
    for (const [key, d] of Object.entries(decks))
      for (const p of d.positions) items.push({ key, fen: p.fen });
    setMode("all");
    advance(decks, "all", mixed ? shuffle(items) : items);
  }

  function startDue() {
    setMode("due");
    advance(decks, "due", []);
  }

  // Positions along the line from the start to the current card.
  const nodes: TreeNode[] = [pgn.root];
  for (const i of path) nodes.push(nodes[nodes.length - 1].children[i]);
  const livePly = path.length;
  const browsing = position !== null && viewPly !== null && viewPly < livePly;
  const answerNode = position
    ? nodes[livePly].children.find((c) => c.san === position.answer)
    : undefined;
  const revealed =
    phase.kind === "correct"
      ? phase.san
      : phase.kind === "incorrect"
        ? position?.answer
        : undefined;

  if (analysis) {
    return (
      <Analysis
        startFen={pgn.root.fen}
        moves={analysis.moves}
        comments={analysis.comments}
        initialPly={analysis.ply}
        orientation={pgn.orientation}
        noteTarget={{ rel: currentSource.source.rel, game: currentSource.source.game }}
        onBack={() => setAnalysis(null)}
      />
    );
  }

  function openAnalysis() {
    const sans = nodes.slice(1).map((n) => n.san ?? "");
    const comments = nodes.slice(1).map((n) => n.comment ?? "");
    if (browsing) {
      setAnalysis({ moves: sans, comments, ply: viewPly! });
    } else if (revealed) {
      // After a correct answer the board already shows the move that was played.
      setAnalysis({
        moves: [...sans, revealed],
        comments: [...comments, answerNode?.comment ?? ""],
        ply: phase.kind === "correct" ? sans.length + 1 : sans.length,
      });
    } else {
      setAnalysis({ moves: sans, comments, ply: sans.length });
    }
  }

  let boardFen = position?.fen ?? pgn.root.fen;
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
  if (browsing) {
    const node = nodes[viewPly!];
    boardFen = node.fen;
    shapes = [];
    boardLastMove =
      node.move && "from" in node.move
        ? [makeSquare(node.move.from), makeSquare(node.move.to)]
        : undefined;
  }

  const reviewTimes =
    position && phase.kind === "correct" && mode === "due"
      ? getNextReviewTimes(position.card)
      : null;
  const colorName = pgn.orientation === "white" ? "Bianco" : "Nero";
  const lastNode = livePly > 0 ? nodes[livePly] : undefined;

  return (
    <div className="screen practice">
      <Header
        title={title}
        onBack={onBack}
        right={
          !mixed && singleRel ? (
            <button
              type="button"
              className="pause-toggle"
              onClick={() => {
                setRepertoirePaused(singleRel, !paused);
                scheduleSync(PAUSE_SYNC_DELAY);
              }}
            >
              {paused ? "▶ Riattiva" : "⏸ Pausa"}
            </button>
          ) : undefined
        }
      />
      {!mixed && paused && (
        <div className="paused-banner">
          <span>In pausa: escluso dai ripassi e da Allena tutto. Puoi comunque allenarlo qui.</span>
        </div>
      )}
      <div className="stats-row">
        <span className="pill due">{stats.due} da ripassare</span>
        <span className="pill new">{stats.unseen} nuove</span>
        <span className="pill">{stats.total} totali</span>
      </div>
      {mixed && position && (
        <p className="source">
          <span className={`color-dot ${pgn.orientation}`} /> {currentSource.source.name}
        </p>
      )}
      <Board
        fen={boardFen}
        orientation={pgn.orientation}
        lastMove={boardLastMove}
        shapes={shapes}
        interactive={!!position && phase.kind === "waiting" && !browsing}
        onMove={onMove}
      />
      {position && (
        <>
          <div className="moves compact">
            {nodes.slice(1).map((node, i) => {
              const ply = i + 1;
              const white = node.halfMoves % 2 === 1;
              const number = white
                ? `${Math.ceil(node.halfMoves / 2)}. `
                : i === 0
                  ? `${Math.ceil(node.halfMoves / 2)}... `
                  : "";
              return (
                <button
                  key={ply}
                  type="button"
                  className={`move ${(viewPly ?? livePly) === ply ? "current" : ""} ${node.comment ? "has-note" : ""}`}
                  onClick={() => setViewPly(ply === livePly ? null : ply)}
                >
                  <span className="num">{number}</span>
                  {withSymbols(node, node.san ?? "")}
                </button>
              );
            })}
            {livePly === 0 && <span className="dim">Posizione iniziale</span>}
          </div>
          <div className="nav">
            <button
              type="button"
              aria-label="Inizio"
              disabled={(viewPly ?? livePly) === 0}
              onClick={() => setViewPly(livePly === 0 ? null : 0)}
            >
              ⏮
            </button>
            <button
              type="button"
              aria-label="Indietro"
              disabled={(viewPly ?? livePly) === 0}
              onClick={() => setViewPly((viewPly ?? livePly) - 1)}
            >
              ◀
            </button>
            <button
              type="button"
              aria-label="Avanti"
              disabled={!browsing}
              onClick={() => setViewPly(viewPly! + 1 >= livePly ? null : viewPly! + 1)}
            >
              ▶
            </button>
            <button
              type="button"
              aria-label="Torna alla posizione"
              disabled={!browsing}
              onClick={() => setViewPly(null)}
            >
              ⏭
            </button>
            <button type="button" className="analyse" onClick={openAnalysis}>
              Analizza
            </button>
          </div>
        </>
      )}

      <div className="panel">
        {!position && (
          <div className="done">
            {mode === "all" ? (
              <p>Ripasso completo finito.</p>
            ) : (
              <p>
                {mixed ? "Hai ripassato tutto per ora." : "Niente da ripassare ora."}
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
                  {mixed ? "Ripassa tutti i repertori" : "Ripassa tutto il repertorio"}
                </button>
              )}
            </div>
          </div>
        )}

        {browsing && (
          <>
            <p className="hint">
              Stai rivedendo le mosse che portano alla posizione. Tocca ⏭ per tornare
              all'allenamento.
            </p>
            <Notes
              items={[
                {
                  label: withSymbols(nodes[viewPly!], nodes[viewPly!].san ?? "Inizio"),
                  text: nodes[viewPly!].comment ?? "",
                },
              ]}
            />
          </>
        )}

        {position && phase.kind === "waiting" && !browsing && (
          <p className="hint">Gioca la mossa del tuo repertorio ({colorName}).</p>
        )}

        {position && phase.kind === "incorrect" && !browsing && (
          <div className="result wrong">
            <p>
              <strong>{phase.played}</strong> non è la mossa del repertorio. La mossa giusta è{" "}
              <strong>{withSymbols(answerNode, position.answer)}</strong>.
            </p>
            <div className="buttons">
              <button type="button" onClick={() => setWritingNote(true)}>
                📝 Nota
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => advance(decksRef.current, mode, queue.slice(1))}
              >
                Avanti
              </button>
            </div>
            <NotesHere rel={currentSource.source.rel} fen={phase.playedFen} />
            {writingNote && (
              <NoteEditor
                startFen={pgn.root.fen}
                line={[...nodes.slice(1).map((n) => n.san ?? ""), phase.played]}
                onCancel={() => setWritingNote(false)}
                onSave={(text) => {
                  addNote(currentSource.source.rel, {
                    game: currentSource.source.game,
                    startFen: pgn.root.fen,
                    line: [...nodes.slice(1).map((n) => n.san ?? ""), phase.played],
                    fen: phase.playedFen,
                    text,
                  });
                  setWritingNote(false);
                }}
              />
            )}
          </div>
        )}

        {position && phase.kind === "correct" && reviewTimes && !browsing && (
          <div className="result right">
            <p>
              <strong>{withSymbols(answerNode, phase.san)}</strong> — giusto! Quanto è stato facile?
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

        {position && phase.kind === "correct" && mode === "all" && !browsing && (
          <div className="result right">
            <p>
              <strong>{withSymbols(answerNode, phase.san)}</strong> — giusto!
            </p>
          </div>
        )}

        {position && revealed && !browsing && (
          <Notes
            items={[
              ...(lastNode
                ? [
                    {
                      label: withSymbols(lastNode, lastNode.san ?? ""),
                      text: lastNode.comment ?? "",
                    },
                  ]
                : [{ label: "Inizio", text: pgn.root.comment ?? "" }]),
              { label: withSymbols(answerNode, position.answer), text: answerNode?.comment ?? "" },
            ]}
          />
        )}

        <p className="session">
          Sessione: {session.correct} giuste · {session.incorrect} sbagliate
          {position ? ` · ${queue.length} in coda` : ""}
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
