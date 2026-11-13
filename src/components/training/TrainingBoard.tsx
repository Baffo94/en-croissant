import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Key } from "@lichess-org/chessground/types";
import { Box } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { makeUci, type NormalMove, parseSquare } from "chessops";
import { chessgroundDests } from "chessops/compat";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { Chessground } from "@/chessground/Chessground";
import { moveHighlightAtom, showCoordinatesAtom, showDestsAtom } from "@/state/atoms";
import classes from "@/styles/Chessboard.module.css";
import { positionFromFen } from "@/utils/chessops";
import PromotionModal from "../boards/PromotionModal";

/** A board for the training exercises: shows a position and reports your move (UCI). */
export function TrainingBoard({
  fen,
  orientation,
  movable,
  onMove,
  lastMove,
  shapes = [],
}: {
  fen: string;
  orientation: "white" | "black";
  movable: boolean;
  onMove?: (uci: string) => void;
  lastMove?: [string, string];
  shapes?: DrawShape[];
}) {
  const [pos] = positionFromFen(fen);
  const [pending, setPending] = useState<NormalMove | null>(null);
  // Bumped at every move of yours: the board goes back to `fen` even when the parent
  // keeps the same position (chessground reads the board part of the FEN only).
  const [moves, setMoves] = useState(0);
  const showDests = useAtomValue(showDestsAtom);
  const showCoordinates = useAtomValue(showCoordinatesAtom);
  const moveHighlight = useAtomValue(moveHighlightAtom);
  const { ref, height } = useElementSize();
  const turn = pos?.turn ?? "white";

  return (
    <Box w="100%" h="100%" ref={ref}>
      <Box className={classes.chessboard} style={{ maxWidth: height || undefined }}>
        <PromotionModal
          pendingMove={pending}
          cancelMove={() => {
            setPending(null);
            setMoves((n) => n + 1);
          }}
          confirmMove={(role) => {
            if (pending) onMove?.(makeUci({ ...pending, promotion: role }));
            setPending(null);
            setMoves((n) => n + 1);
          }}
          turn={turn}
          orientation={orientation}
        />
        <Chessground
          fen={`${fen} ${moves}`}
          orientation={orientation}
          turnColor={turn}
          coordinates={showCoordinates !== "no"}
          coordinatesOnSquares={showCoordinates === "all"}
          check={moveHighlight && pos?.isCheck()}
          lastMove={moveHighlight ? (lastMove as Key[] | undefined) : undefined}
          animation={{ enabled: true }}
          drawable={{ enabled: true, visible: true, autoShapes: shapes }}
          movable={{
            free: false,
            color: movable ? turn : undefined,
            dests: movable && pos ? chessgroundDests(pos) : new Map(),
            showDests,
            events: {
              after: (orig, dest) => {
                const from = parseSquare(orig);
                const to = parseSquare(dest);
                if (from === undefined || to === undefined) return;
                const move: NormalMove = { from, to };
                const promotes =
                  pos?.board.get(from)?.role === "pawn" && (dest[1] === "8" || dest[1] === "1");
                if (promotes) setPending(move);
                else {
                  onMove?.(makeUci(move));
                  setMoves((n) => n + 1);
                }
              },
            },
          }}
        />
      </Box>
    </Box>
  );
}
