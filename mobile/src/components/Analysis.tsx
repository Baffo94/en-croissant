import type { DrawShape } from "@lichess-org/chessground/draw";
import { makeSquare, makeUci, type NormalMove, parseUci } from "chessops";
import { normalizeMove } from "chessops/chess";
import { makeFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { useEffect, useMemo, useRef, useState } from "react";
import { positionFromFen } from "@/utils/chessops";
import { useBackHandler } from "../back";
import { useAppState } from "../state";
import { cloudEval } from "../cloudEval";
import { type Analysis as EngineAnalysis, Engine, formatScore, pvToSan, whiteBar } from "../engine";
import { Board } from "./Board";
import { ExplorerPanel } from "./ExplorerPanel";
import { CommentItem } from "./CommentItem";
import { Header } from "./Practice";

type Ply = { san: string; uci: string; fen: string };

/** Replays SAN moves from `fen`, stopping at the first illegal one. */
function replay(fen: string, sans: string[]): Ply[] {
  const [pos] = positionFromFen(fen);
  if (!pos) return [];
  const plies: Ply[] = [];
  for (const san of sans) {
    const move = parseSan(pos, san);
    if (!move) break;
    const normalized = makeSan(pos, move);
    pos.play(move);
    plies.push({ san: normalized, uci: makeUci(move), fen: makeFen(pos.toSetup()) });
  }
  return plies;
}

/** Move number prefix for the ply that starts from `fen` ("12." or "12..."). */
function moveNumber(fen: string, always: boolean): string {
  const [, turn, , , , full] = fen.split(" ");
  if (turn === "w") return `${full}. `;
  return always ? `${full}... ` : "";
}

const ENGINE_DEPTH = 20;

export function Analysis({
  startFen,
  moves,
  comments = [],
  initialPly,
  orientation,
  onEditComment,
  onBack,
}: {
  startFen: string;
  /** SAN moves from `startFen` (the line of the repertoire). */
  moves: string[];
  /** PGN comment of each move of `moves`, if any. */
  comments?: string[];
  initialPly: number;
  orientation: "white" | "black";
  /** Saves the comment of repertoire move number `ply` (1 = first move of `moves`). */
  onEditComment?: (ply: number, text: string) => boolean;
  onBack: () => void;
}) {
  useBackHandler(onBack);
  const [history, setHistory] = useState<Ply[]>(() => replay(startFen, moves));
  const [ply, setPly] = useState(() => Math.min(initialPly, moves.length));
  const [flipped, setFlipped] = useState(false);
  // Off by default: started (and loaded) only on request.
  const [engineOn, setEngineOn] = useState(false);
  const [tab, setTab] = useState<"engine" | "explorer">("engine");
  const [analysis, setAnalysis] = useState<(EngineAnalysis & { source?: "lichess" }) | null>(null);
  // Position for which the user asked the phone's engine even though Lichess has it.
  const [forced, setForced] = useState<string | null>(null);
  const [askingCloud, setAskingCloud] = useState(false);
  const token = useAppState((s) => s.explorer.token);
  const engine = useRef<Engine | null>(null);
  const movesRef = useRef<HTMLDivElement>(null);

  const fen = ply === 0 ? startFen : history[ply - 1].fen;

  useEffect(() => () => engine.current?.destroy(), []);

  useEffect(() => {
    setAnalysis(null);
    if (!engineOn) {
      engine.current?.stop();
      return;
    }
    const [pos] = positionFromFen(fen);
    if (!pos || pos.isEnd()) {
      engine.current?.stop();
      return;
    }
    const runEngine = () => {
      if (!engine.current) engine.current = new Engine();
      engine.current.analyse(fen, setAnalysis, { multiPv: 3, depth: ENGINE_DEPTH });
    };
    if (forced === fen) {
      runEngine();
      return;
    }
    // Lichess first: if it already has the position (usually much deeper), the
    // phone's engine does not start at all.
    engine.current?.stop();
    let cancelled = false;
    setAskingCloud(true);
    cloudEval(fen, token).then((cloud) => {
      if (cancelled) return;
      setAskingCloud(false);
      if (cloud) setAnalysis(cloud);
      else runEngine();
    });
    return () => {
      cancelled = true;
      setAskingCloud(false);
    };
  }, [fen, engineOn, forced, token]);

  useEffect(() => {
    movesRef.current
      ?.querySelector(".current")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [ply]);

  function play(move: NormalMove) {
    const [pos] = positionFromFen(fen);
    if (!pos) return;
    let m = normalizeMove(pos, move) as NormalMove;
    const piece = pos.board.get(m.from);
    const rank = Math.floor(m.to / 8);
    if (piece?.role === "pawn" && (rank === 0 || rank === 7) && !m.promotion)
      m = { ...m, promotion: "queen" };
    if (!pos.isLegal(m)) return;
    const uci = makeUci(m);
    if (history[ply]?.uci === uci) {
      setPly(ply + 1);
      return;
    }
    const san = makeSan(pos, m);
    pos.play(m);
    setHistory([...history.slice(0, ply), { san, uci, fen: makeFen(pos.toSetup()) }]);
    setPly(ply + 1);
  }

  const lastMove = useMemo(() => {
    if (ply === 0) return undefined;
    const move = parseUci(history[ply - 1].uci) as NormalMove | undefined;
    return move ? ([makeSquare(move.from), makeSquare(move.to)] as [string, string]) : undefined;
  }, [history, ply]);

  const lines = analysis && analysis.fen === fen ? analysis.lines : [];
  const best = lines[0];
  const shapes: DrawShape[] = [];
  if (best?.pv[0]) {
    const move = parseUci(best.pv[0]) as NormalMove | undefined;
    if (move && "from" in move)
      shapes.push({ orig: makeSquare(move.from), dest: makeSquare(move.to), brush: "paleBlue" });
  }

  const [pos] = positionFromFen(fen);
  const status = pos?.isCheckmate()
    ? "Scacco matto"
    : pos?.isStalemate()
      ? "Stallo"
      : pos?.isEnd()
        ? "Patta"
        : null;
  const boardOrientation = flipped ? (orientation === "white" ? "black" : "white") : orientation;
  const bar = best ? whiteBar(best.score) : 50;

  return (
    <div className="screen analysis">
      <Header
        title="Analisi"
        onBack={onBack}
        right={
          <>
            <button
              type="button"
              className="icon"
              aria-label="Gira la scacchiera"
              onClick={() => setFlipped((f) => !f)}
            >
              ⇅
            </button>
            <button
              type="button"
              className={`engine-toggle ${engineOn ? "on" : ""}`}
              aria-label="Motore"
              onClick={() => setEngineOn((v) => !v)}
            >
              {engineOn ? "Motore ON" : "Motore OFF"}
            </button>
          </>
        }
      />

      {engineOn && (
        <div className="eval">
          <div className="eval-bar">
            <div className="eval-white" style={{ width: `${bar}%` }} />
          </div>
          <div className="eval-text">
            <strong>{status ?? (best ? formatScore(best.score) : "…")}</strong>
            {!status && (
              <span>
                {analysis && analysis.fen === fen
                  ? `${analysis.source === "lichess" ? "Lichess · " : ""}profondità ${analysis.depth}`
                  : askingCloud
                    ? "cerco su Lichess…"
                    : "calcolo…"}
              </span>
            )}
          </div>
        </div>
      )}

      <Board
        fen={fen}
        orientation={boardOrientation}
        lastMove={lastMove}
        shapes={shapes}
        interactive
        onMove={play}
      />

      <div className="nav">
        <button type="button" onClick={() => setPly(0)} disabled={ply === 0} aria-label="Inizio">
          ⏮
        </button>
        <button
          type="button"
          onClick={() => setPly(ply - 1)}
          disabled={ply === 0}
          aria-label="Indietro"
        >
          ◀
        </button>
        <button
          type="button"
          onClick={() => setPly(ply + 1)}
          disabled={ply >= history.length}
          aria-label="Avanti"
        >
          ▶
        </button>
        <button
          type="button"
          onClick={() => setPly(history.length)}
          disabled={ply >= history.length}
          aria-label="Fine"
        >
          ⏭
        </button>
      </div>

      <div className="moves" ref={movesRef}>
        {history.length === 0 && (
          <span className="dim">Muovi un pezzo per esplorare la posizione.</span>
        )}
        {history.map((p, i) => {
          const before = i === 0 ? startFen : history[i - 1].fen;
          const explored = i >= moves.length || history[i].san !== moves[i];
          return (
            <button
              key={`${i}-${p.uci}`}
              type="button"
              className={`move ${i + 1 === ply ? "current" : ""} ${explored ? "explored" : ""}`}
              onClick={() => setPly(i + 1)}
            >
              <span className="num">{moveNumber(before, i === 0)}</span>
              {p.san}
            </button>
          );
        })}
      </div>

      {(() => {
        // Comment of the repertoire move shown on the board (not of explored moves).
        const i = ply - 1;
        const fromRepertoire =
          i >= 0 && i < moves.length && history.slice(0, ply).every((p, j) => p.san === moves[j]);
        const note = fromRepertoire ? comments[i] : "";
        if (!fromRepertoire || (!note && !onEditComment)) return null;
        return (
          <div className="notes analysis-note">
            <CommentItem
              key={`${ply}-${note}`}
              label={history[i].san}
              text={note}
              onSave={onEditComment ? (text) => onEditComment(ply, text) : undefined}
            />
          </div>
        );
      })()}

      <div className="tabs">
        <button
          type="button"
          className={tab === "engine" ? "active" : ""}
          onClick={() => setTab("engine")}
        >
          Motore
        </button>
        <button
          type="button"
          className={tab === "explorer" ? "active" : ""}
          onClick={() => setTab("explorer")}
        >
          Esploratore
        </button>
      </div>

      {tab === "explorer" && (
        <ExplorerPanel
          fen={fen}
          onPlay={(uci) => {
            const move = parseUci(uci) as NormalMove | undefined;
            if (move) play(move);
          }}
        />
      )}

      {tab === "engine" && !engineOn && (
        <p className="dim tab-note">Motore spento: riaccendilo in alto.</p>
      )}
      {tab === "engine" && engineOn && (
        <div className="lines">
          {lines.map((line) => {
            const sans = pvToSan(fen, line.pv, 10);
            const [, turn, , , , full] = fen.split(" ");
            let n = Number(full);
            let white = turn === "w";
            const text = sans
              .map((san, i) => {
                const prefix = white ? `${n}. ` : i === 0 ? `${n}... ` : "";
                if (!white) n++;
                white = !white;
                return prefix + san;
              })
              .join(" ");
            return (
              <button
                key={line.multipv}
                type="button"
                className="engine-line"
                onClick={() => {
                  const move = parseUci(line.pv[0]) as NormalMove | undefined;
                  if (move) play(move);
                }}
              >
                <span className={`score ${line.score.value >= 0 ? "plus" : "minus"}`}>
                  {formatScore(line.score)}
                </span>
                <span className="pv">{text}</span>
              </button>
            );
          })}
          {lines.length === 0 && !status && (
            <p className="dim">
              {askingCloud ? "Cerco la valutazione su Lichess…" : "Stockfish sta calcolando…"}
            </p>
          )}
          {analysis?.source === "lichess" && analysis.fen === fen && (
            <button type="button" className="link-button" onClick={() => setForced(fen)}>
              Calcola col motore del telefono
            </button>
          )}
        </div>
      )}
      {tab === "engine" && (
        <p className="engine-credit">
          {engineOn && analysis?.source === "lichess" && analysis.fen === fen
            ? "Valutazione cloud di Lichess"
            : "Stockfish 19 lite"}
        </p>
      )}
    </div>
  );
}
