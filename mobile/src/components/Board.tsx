import "@lichess-org/chessground/assets/chessground.base.css";
import "@lichess-org/chessground/assets/chessground.brown.css";
import "@lichess-org/chessground/assets/chessground.cburnett.css";
import { Chessground } from "@lichess-org/chessground";
import type { Api } from "@lichess-org/chessground/api";
import type { Config } from "@lichess-org/chessground/config";
import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Key } from "@lichess-org/chessground/types";
import { makeSquare, type NormalMove, parseSquare } from "chessops";
import { chessgroundDests } from "chessops/compat";
import { parseFen } from "chessops/fen";
import { useEffect, useRef } from "react";
import { positionFromFen } from "@/utils/chessops";

export type BoardProps = {
  fen: string;
  orientation: "white" | "black";
  lastMove?: [string, string];
  shapes?: DrawShape[];
  /** When false the pieces can't be moved. */
  interactive: boolean;
  onMove?: (move: NormalMove) => void;
};

export function Board({ fen, orientation, lastMove, shapes, interactive, onMove }: BoardProps) {
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  useEffect(() => {
    if (!el.current) return;
    api.current = Chessground(el.current, { coordinates: true, animation: { duration: 200 } });
    return () => api.current?.destroy();
  }, []);

  useEffect(() => {
    const [pos] = positionFromFen(fen);
    const turn = parseFen(fen).unwrap().turn;
    const config: Config = {
      fen,
      orientation,
      turnColor: turn,
      lastMove: lastMove as Key[] | undefined,
      check: pos?.isCheck() ? turn : false,
      movable: {
        free: false,
        color: interactive ? turn : undefined,
        dests: interactive && pos ? chessgroundDests(pos) : new Map(),
        showDests: true,
        events: {
          after: (orig, dest) => {
            const from = parseSquare(orig);
            const to = parseSquare(dest);
            if (from === undefined || to === undefined) return;
            onMoveRef.current?.({ from, to });
          },
        },
      },
      premovable: { enabled: false },
      drawable: { enabled: false, autoShapes: shapes ?? [] },
    };
    api.current?.set(config);
    api.current?.setAutoShapes(shapes ?? []);
  }, [fen, orientation, lastMove, shapes, interactive]);

  return <div className="board" ref={el} />;
}

export function squareName(sq: number): string {
  return makeSquare(sq);
}
