import type { DrawShape } from "@lichess-org/chessground/draw";
import { makeSquare, type NormalMove } from "chessops";
import { normalizeMove } from "chessops/chess";
import { makeSan } from "chessops/san";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Annotation } from "@/utils/annotation";
import { positionFromFen } from "@/utils/chessops";
import { countMoves } from "@/utils/repertoireEdit";
import type { TreeNode } from "@/utils/treeReducer";
import { useBackHandler } from "../back";
import { editRepertoire, setComment, undoEdit } from "../comments";
import { numbered } from "../moveLabel";
import { gamesOf } from "../repertoires";
import { useAppState } from "../state";
import { Analysis } from "./Analysis";
import { Board } from "./Board";
import { Icon } from "./Icon";
import { Header } from "./Practice";
import { Sheet } from "./Sheet";

const SYMBOLS: Annotation[] = ["!!", "!", "!?", "?!", "?", "??"];

/** The nodes along `line` (root first); stops at the first move not in the tree. */
function walk(root: TreeNode, line: readonly string[]): TreeNode[] {
  const nodes = [root];
  for (const san of line) {
    const next = nodes[nodes.length - 1].children.find((c) => c.san === san);
    if (!next) break;
    nodes.push(next);
  }
  return nodes;
}

function symbolsOf(node: TreeNode): string {
  return node.annotations.filter((a) => SYMBOLS.includes(a)).join("");
}

function squares(node: TreeNode): [string, string] | undefined {
  return node.move && "from" in node.move
    ? [makeSquare(node.move.from), makeSquare(node.move.to)]
    : undefined;
}

/** Full tree of the game, indented, for the "tree" sheet. */
function TreeView({
  root,
  current,
  onPick,
}: {
  root: TreeNode;
  current: string;
  onPick: (line: string[]) => void;
}) {
  type Row = { line: string[]; node: TreeNode; depth: number; main: boolean };
  const rows: Row[] = [];
  // Each line of moves is a row; variations are indented rows below their move.
  const visit = (node: TreeNode, line: string[], depth: number) => {
    let cur = node;
    let curLine = line;
    let first = true;
    while (cur.children.length > 0) {
      const [main, ...variations] = cur.children;
      const mainLine = [...curLine, main.san!];
      rows.push({ line: mainLine, node: main, depth, main: !first || depth === 0 });
      for (const v of variations) {
        const vLine = [...curLine, v.san!];
        rows.push({ line: vLine, node: v, depth: depth + 1, main: false });
        visit(v, vLine, depth + 1);
      }
      cur = main;
      curLine = mainLine;
      first = false;
    }
  };
  visit(root, [], 0);
  // Group consecutive rows of the same depth into lines of text.
  type Group = { depth: number; moves: Row[] };
  const groups: Group[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    const continues =
      last &&
      last.depth === row.depth &&
      last.moves[last.moves.length - 1].line.length === row.line.length - 1 &&
      last.moves[last.moves.length - 1].line.every((s, i) => row.line[i] === s);
    if (continues) last.moves.push(row);
    else groups.push({ depth: row.depth, moves: [row] });
  }
  return (
    <div className="tree-view">
      {groups.map((g) => (
        <div
          key={g.moves[0].line.join(" ")}
          className="tree-line"
          style={{ paddingLeft: `${Math.min(g.depth, 6) * 14}px` }}
        >
          {g.moves.map((r, i) => {
            const ply = r.node.halfMoves;
            const n = Math.ceil(ply / 2);
            const label = ply % 2 === 1 ? `${n}.` : i === 0 ? `${n}...` : "";
            const key = r.line.join(" ");
            return (
              <button
                key={key}
                type="button"
                className={`move${key === current ? " current" : ""}${r.node.comment ? " has-note" : ""}`}
                onClick={() => onPick(r.line)}
              >
                {label && <span className="num">{label}</span>}
                {r.node.san}
                {symbolsOf(r.node)}
              </button>
            );
          })}
        </div>
      ))}
      {groups.length === 0 && <p className="dim">Nessuna mossa.</p>}
    </div>
  );
}

/**
 * Editor of a repertoire on the phone. You move through the tree (path, continuations,
 * full tree in a sheet) and change it: a move played on the board that is not in the
 * repertoire is added; the move shown can be made the main one, deleted, commented,
 * annotated. Every change is saved at once (with "Annulla" for a few seconds) and goes
 * to the PC with the sync, where it stays listed and can be undone.
 */
export function RepertoireEditor({
  rel,
  game,
  title,
  initialLine,
  onDone,
}: {
  rel: string;
  game: number;
  title: string;
  initialLine: string[];
  onDone: () => void;
}) {
  const file = useAppState((s) => s.files[rel]);
  const pgn = useMemo(
    () =>
      file === undefined
        ? undefined
        : gamesOf({ files: { [rel]: file }, decks: {}, pauses: {} }, rel)[game],
    [file, rel, game],
  );
  const [line, setLine] = useState<string[]>(initialLine);
  const [sheet, setSheet] = useState<"tree" | "menu" | "comment" | "symbols" | "delete" | null>(
    null,
  );
  const [draft, setDraft] = useState("");
  const [toast, setToast] = useState<{ text: string; id: string } | null>(null);
  const [analysis, setAnalysis] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathRef = useRef<HTMLDivElement>(null);

  // Sheets and the analysis register their own handler on top of this one.
  useBackHandler(onDone);

  const nodes = pgn ? walk(pgn.root, line) : [];
  const valid = nodes.length - 1;
  // The tree changed under the line (a move deleted): stay on the part that exists.
  useEffect(() => {
    if (pgn && valid < line.length) setLine(line.slice(0, valid));
  }, [pgn, valid, line]);

  useEffect(() => {
    pathRef.current?.scrollTo({ left: pathRef.current.scrollWidth, behavior: "smooth" });
  }, [line.length]);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  if (!pgn) {
    return (
      <div className="screen">
        <Header title={title} onBack={onDone} />
        <p className="empty">Impossibile leggere questo repertorio.</p>
      </div>
    );
  }

  const cur = line.slice(0, valid);
  const node = nodes[valid];
  const parent = valid > 0 ? nodes[valid - 1] : null;
  const isMain = !parent || parent.children[0] === node;
  const startFen = pgn.root.fen;
  const label = (l: readonly string[], n: TreeNode) =>
    numbered(startFen, l.length, `${n.san}${symbolsOf(n)}`);
  const yours = (n: TreeNode) => (pgn.orientation === "white") === (n.halfMoves % 2 === 0);

  const showToast = (text: string, id: string | null) => {
    if (!id) return;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, id });
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  };

  const onMove = (raw: NormalMove) => {
    const [pos] = positionFromFen(node.fen);
    if (!pos) return;
    let move = normalizeMove(pos, raw) as NormalMove;
    const piece = pos.board.get(move.from);
    const rank = Math.floor(move.to / 8);
    if (piece?.role === "pawn" && (rank === 0 || rank === 7)) {
      // Promotion: the piece of an existing continuation with these squares, else a queen.
      const known = node.children.find(
        (c) => c.move && "from" in c.move && c.move.from === move.from && c.move.to === move.to,
      );
      move = {
        ...move,
        promotion: known?.move && "promotion" in known.move ? known.move.promotion : "queen",
      };
    }
    if (!pos.isLegal(move)) return;
    const san = makeSan(pos, move);
    const next = [...cur, san];
    if (node.children.some((c) => c.san === san)) {
      setLine(next);
      return;
    }
    const id = editRepertoire(rel, game, { kind: "add", line: next });
    if (id) {
      setLine(next);
      showToast(
        `Aggiunta ${numbered(startFen, next.length, san)}${
          node.children.length > 0 ? " come variante" : ""
        }`,
        id,
      );
    }
  };

  const promote = () => {
    const id = editRepertoire(rel, game, { kind: "promote", line: cur });
    setSheet(null);
    showToast(`${label(cur, node)} è ora la mossa principale`, id);
  };

  const remove = () => {
    const moves = countMoves(node);
    const id = editRepertoire(rel, game, { kind: "delete", line: cur });
    setSheet(null);
    if (id) {
      const text = `Eliminata ${label(cur, node)}${moves > 1 ? ` e ${moves - 1} mosse seguenti` : ""}`;
      setLine(cur.slice(0, -1));
      showToast(text, id);
    }
  };

  const saveComment = () => {
    setComment(rel, game, cur, draft);
    setSheet(null);
  };

  const setSymbol = (symbol: Annotation | null) => {
    const id = editRepertoire(rel, game, {
      kind: "nags",
      line: cur,
      nags: symbol ? [symbol] : [],
    });
    setSheet(null);
    if (id)
      showToast(symbol ? `Simbolo ${symbol} a ${node.san}` : `Simboli tolti a ${node.san}`, id);
  };

  if (analysis) {
    return (
      <Analysis
        startFen={startFen}
        moves={cur}
        comments={nodes.slice(1).map((n) => n.comment ?? "")}
        onEditComment={(ply, text) => setComment(rel, game, cur.slice(0, ply), text)}
        initialPly={cur.length}
        orientation={pgn.orientation}
        onBack={() => setAnalysis(false)}
      />
    );
  }

  const shapes: DrawShape[] = node.children
    .map((c, i): DrawShape | null => {
      const sq = squares(c);
      return sq
        ? {
            orig: sq[0] as DrawShape["orig"],
            dest: sq[1] as DrawShape["orig"],
            brush: i === 0 ? "green" : "blue",
          }
        : null;
    })
    .filter((s): s is DrawShape => s !== null);

  const toMove = node.halfMoves % 2 === 0 ? "white" : "black";
  const yourTurn = pgn.orientation === toMove;

  return (
    <div className="screen editor">
      <Header
        title={title}
        onBack={onDone}
        right={
          <>
            <button
              type="button"
              className="icon"
              aria-label="Albero delle varianti"
              onClick={() => setSheet("tree")}
            >
              <Icon name="tree" size={22} />
            </button>
            <button type="button" className="done-btn" onClick={onDone}>
              Fatto
            </button>
          </>
        }
      />
      <Board
        fen={node.fen}
        orientation={pgn.orientation}
        lastMove={squares(node)}
        shapes={shapes}
        interactive
        onMove={onMove}
      />

      <div className="edit-path" ref={pathRef}>
        <button
          type="button"
          className={`move${cur.length === 0 ? " current" : ""}`}
          onClick={() => setLine([])}
        >
          Inizio
        </button>
        {nodes.slice(1).map((n, i) => {
          const l = cur.slice(0, i + 1);
          const ply = n.halfMoves;
          const num =
            ply % 2 === 1 ? `${Math.ceil(ply / 2)}.` : i === 0 ? `${Math.ceil(ply / 2)}...` : "";
          return (
            <button
              key={l.join(" ")}
              type="button"
              className={`move${i + 1 === cur.length ? " current" : ""}${n.comment ? " has-note" : ""}`}
              onClick={() => setLine(l)}
            >
              {num && <span className="num">{num}</span>}
              {n.san}
              {symbolsOf(n)}
            </button>
          );
        })}
      </div>

      <div className="edit-bar">
        <button
          type="button"
          aria-label="Mossa precedente"
          disabled={cur.length === 0}
          onClick={() => setLine(cur.slice(0, -1))}
        >
          ◀
        </button>
        <button
          type="button"
          aria-label="Mossa principale successiva"
          disabled={node.children.length === 0}
          onClick={() => setLine([...cur, node.children[0].san!])}
        >
          ▶
        </button>
        <button
          type="button"
          aria-label="Commento"
          disabled={cur.length === 0}
          className={node.comment ? "on" : ""}
          onClick={() => {
            setDraft(node.comment ?? "");
            setSheet("comment");
          }}
        >
          <Icon name="message" size={18} />
        </button>
        <button
          type="button"
          aria-label="Altre azioni"
          disabled={cur.length === 0}
          onClick={() => setSheet("menu")}
        >
          <Icon name="dots" size={18} />
        </button>
        <button type="button" aria-label="Analizza la posizione" onClick={() => setAnalysis(true)}>
          <Icon name="search" size={18} />
        </button>
      </div>

      <div className="panel edit-panel">
        {cur.length > 0 && (
          <div className="edit-current">
            <span className="edit-move">{label(cur, node)}</span>
            <span className={`pill ${isMain ? "ok" : ""}`}>
              {isMain ? "principale" : "variante"}
            </span>
            {yours(node) && <span className="pill">tua mossa</span>}
          </div>
        )}
        {node.comment && <p className="edit-comment">{node.comment}</p>}

        <p className="edit-label">
          {node.children.length === 0
            ? "Fine della linea"
            : cur.length === 0
              ? "Mosse iniziali"
              : `Dopo ${label(cur, node)}`}
        </p>
        <div className="chips">
          {node.children.map((c, i) => (
            <button
              key={c.san}
              type="button"
              className={`chip cont${i === 0 ? " main" : ""}${c.comment ? " has-note" : ""}`}
              onClick={() => setLine([...cur, c.san!])}
            >
              {i === 0 && <Icon name="star" size={14} />}
              {numbered(startFen, cur.length + 1, `${c.san}${symbolsOf(c)}`)}
            </button>
          ))}
        </div>
        <p className="hint">
          {yourTurn
            ? "Gioca sulla scacchiera la tua mossa: se non c'è, viene aggiunta al repertorio."
            : "Gioca sulla scacchiera una risposta dell'avversario per aggiungerla."}
        </p>
      </div>

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          <button
            type="button"
            onClick={() => {
              undoEdit(toast.id);
              setToast(null);
            }}
          >
            <Icon name="undo" size={16} /> Annulla
          </button>
        </div>
      )}

      {sheet === "tree" && (
        <Sheet title="Albero delle varianti" onClose={() => setSheet(null)}>
          <TreeView
            root={pgn.root}
            current={cur.join(" ")}
            onPick={(l) => {
              setLine(l);
              setSheet(null);
            }}
          />
        </Sheet>
      )}

      {sheet === "menu" && (
        <Sheet title={label(cur, node)} onClose={() => setSheet(null)}>
          <div className="sheet-actions">
            {!isMain && (
              <button type="button" onClick={promote}>
                <Icon name="star" size={18} /> Rendi mossa principale
              </button>
            )}
            <button type="button" onClick={() => setSheet("symbols")}>
              <span className="sym">!?</span> Simboli
            </button>
            <button type="button" className="danger" onClick={() => setSheet("delete")}>
              <Icon name="trash" size={18} /> Elimina mossa
            </button>
          </div>
        </Sheet>
      )}

      {sheet === "symbols" && (
        <Sheet title={`Simboli di ${node.san}`} onClose={() => setSheet(null)}>
          <div className="chips symbols">
            {SYMBOLS.map((s) => (
              <button
                key={s}
                type="button"
                className={`chip${node.annotations.includes(s) ? " selected" : ""}`}
                onClick={() => setSymbol(node.annotations.includes(s) ? null : s)}
              >
                {s}
              </button>
            ))}
            <button type="button" className="chip" onClick={() => setSymbol(null)}>
              Nessuno
            </button>
          </div>
        </Sheet>
      )}

      {sheet === "delete" && (
        <Sheet title="Eliminare la mossa?" onClose={() => setSheet(null)}>
          <p className="sheet-hint">
            {countMoves(node) > 1
              ? `Vengono eliminate ${label(cur, node)} e le ${countMoves(node) - 1} mosse che la seguono.`
              : `Viene eliminata ${label(cur, node)}.`}{" "}
            {isMain && parent && parent.children.length > 1
              ? `La variante ${numbered(startFen, cur.length, parent.children[1].san!)} diventa la principale.`
              : ""}
            Potrai annullare subito, o dal PC in seguito.
          </p>
          <div className="sheet-buttons">
            <button type="button" onClick={() => setSheet(null)}>
              Annulla
            </button>
            <button type="button" className="danger primary" onClick={remove}>
              Elimina
            </button>
          </div>
        </Sheet>
      )}

      {sheet === "comment" && (
        <Sheet title={`Commento a ${label(cur, node)}`} onClose={() => setSheet(null)}>
          <textarea
            className="sheet-text"
            rows={4}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Scrivi il commento…"
          />
          <div className="sheet-buttons">
            <button type="button" onClick={() => setDraft("")} disabled={!draft}>
              Cancella testo
            </button>
            <button type="button" className="primary" onClick={saveComment}>
              Salva
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
