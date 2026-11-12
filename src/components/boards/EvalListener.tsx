import { parseUci } from "chessops";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import equal from "fast-deep-equal";
import { useAtom, useAtomValue } from "jotai";
import { startTransition, useContext, useEffect, useMemo, useRef } from "react";
import { match } from "ts-pattern";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { commands, type EngineOptions, events, type GoMode } from "@/bindings";
import {
  activeTabAtom,
  currentThreatAtom,
  engineMovesFamily,
  engineProgressFamily,
  enginesAtom,
  evalCacheSettingsAtom,
  firstEngineWithLinesFamily,
  tabEngineSettingsFamily,
} from "@/state/atoms";
import { getVariationLine } from "@/utils/chess";
import {
  fenAfter,
  fromBestMoves,
  isOpeningFen,
  MIN_STORED_DEPTH,
  toBestMoves,
} from "@/utils/evalCache";
import { getBestMoves as chessdbGetBestMoves } from "@/utils/chessdb/api";
import { positionFromFen, swapMove } from "@/utils/chessops";
import {
  type Engine,
  type LocalEngine,
  getBestMoves as localGetBestMoves,
  stopEngine,
} from "@/utils/engines";
import { getBestMoves as lichessGetBestMoves } from "@/utils/lichess/api";
import { useThrottledEffect } from "@/utils/misc";
import { TreeStateContext } from "../common/TreeStateContext";

function EvalListener() {
  const [engines] = useAtom(enginesAtom);
  const threat = useAtomValue(currentThreatAtom);
  const store = useContext(TreeStateContext)!;
  const fen = useStore(store, (s) => s.root.fen);

  const moves = useStore(
    store,
    useShallow((s) => getVariationLine(s.root, s.position)),
  );

  const [pos, error] = positionFromFen(fen);
  if (pos) {
    for (const uci of moves) {
      const move = parseUci(uci);
      if (!move) {
        console.log("Invalid move", uci);
        break;
      }
      pos.play(move);
    }
  }

  const isGameOver = pos?.isEnd() ?? false;
  const isCheck = pos?.isCheck() ?? false;
  const effectiveThreat = (threat as boolean) && !isCheck;
  const finalFen = useMemo(() => (pos ? makeFen(pos.toSetup()) : null), [pos]);

  const { searchingFen, searchingMoves } = useMemo(
    () =>
      match(effectiveThreat)
        .with(true, () => ({
          searchingFen: swapMove(finalFen || INITIAL_FEN),
          searchingMoves: [],
        }))
        .with(false, () => ({
          searchingFen: fen,
          searchingMoves: moves,
        }))
        .exhaustive(),
    [fen, moves, effectiveThreat, finalFen],
  );

  const firstEngineWithLines = useAtomValue(
    firstEngineWithLinesFamily({
      fen: searchingFen,
      gameMoves: searchingMoves,
    }),
  );

  return (engines ?? [])
    .filter((e) => e.loaded)
    .map((e) => (
      <EngineListener
        key={e.id}
        engine={e}
        firstEngineWithLines={firstEngineWithLines}
        isGameOver={isGameOver}
        finalFen={finalFen || ""}
        searchingFen={searchingFen}
        searchingMoves={searchingMoves}
        fen={fen}
        moves={moves}
        threat={effectiveThreat}
        isCheck={isCheck}
      />
    ));
}

function EngineListener({
  engine,
  firstEngineWithLines,
  isGameOver,
  isCheck,
  finalFen,
  searchingFen,
  searchingMoves,
  fen,
  moves,
  threat,
}: {
  engine: Engine;
  firstEngineWithLines: string | null;
  isGameOver: boolean;
  isCheck: boolean;
  finalFen: string;
  searchingFen: string;
  searchingMoves: string[];
  fen: string;
  moves: string[];
  threat: boolean;
}) {
  const store = useContext(TreeStateContext)!;
  const setScore = useStore(store, (s) => s.setScore);
  const activeTab = useAtomValue(activeTabAtom);

  const [, setProgress] = useAtom(engineProgressFamily({ engine: engine.id, tab: activeTab! }));

  const [, setEngineVariation] = useAtom(engineMovesFamily({ engine: engine.id, tab: activeTab! }));
  const cacheSettings = useAtomValue(evalCacheSettingsAtom);
  /**
   * Opening position being analysed, with the depth already known from the local
   * database: the engine's lines replace the stored ones only once they go deeper,
   * and are stored when they do.
   */
  const stored = useRef<{ key: string; fen: string; depth: number } | null>(null);
  const useCache = engine.type === "local" && cacheSettings.enabled && !threat;
  const [settings] = useAtom(
    tabEngineSettingsFamily({
      engineId: engine.id,
      defaultSettings: engine.settings ?? undefined,
      defaultGo: engine.go ?? undefined,
      tab: activeTab!,
    }),
  );
  useEffect(() => {
    if (!settings.enabled) return;
    const unlisten = events.bestMovesPayload.listen(({ payload }) => {
      const ev = payload.bestLines;
      if (
        payload.engine === engine.id &&
        payload.tab === activeTab &&
        payload.fen === searchingFen &&
        equal(payload.moves, searchingMoves) &&
        settings.enabled &&
        !isGameOver
      ) {
        const key = `${searchingFen}:${searchingMoves.join(",")}`;
        const known = stored.current?.key === key ? stored.current : null;
        if (known && ev[0] && ev[0].depth <= known.depth) {
          // Still shallower than the stored evaluation, which stays on screen.
          setProgress(payload.progress);
          return;
        }
        if (known && ev[0] && ev[0].depth >= MIN_STORED_DEPTH) {
          known.depth = ev[0].depth;
          commands.evalCachePut(known.fen, fromBestMoves(ev, engine.name)).catch(() => {});
        }
        startTransition(() => {
          setEngineVariation((prev) => {
            const newMap = new Map(prev);
            newMap.set(`${searchingFen}:${searchingMoves.join(",")}`, ev);
            if (threat) {
              newMap.delete(`${fen}:${moves.join(",")}`);
            } else if (finalFen && !isCheck) {
              newMap.delete(`${swapMove(finalFen)}:`);
            }
            return newMap;
          });
          setProgress(payload.progress);
          const shouldSetScore =
            firstEngineWithLines === engine.id || firstEngineWithLines === null;
          if (shouldSetScore) {
            setScore(ev[0].score);
          }
        });
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [
    activeTab,
    setScore,
    settings.enabled,
    isGameOver,
    isCheck,
    searchingFen,
    JSON.stringify(searchingMoves),
    engine.id,
    setEngineVariation,
    firstEngineWithLines,
    threat,
    fen,
    JSON.stringify(moves),
    finalFen,
  ]);

  const getBestMoves = useMemo(
    () =>
      match(engine.type)
        .with(
          "local",
          () => (fen: string, goMode: GoMode, options: EngineOptions) =>
            localGetBestMoves(engine as LocalEngine, fen, goMode, options),
        )
        .with("chessdb", () => chessdbGetBestMoves)
        .with("lichess", () => lichessGetBestMoves)
        .exhaustive(),
    [engine.type, engine],
  );

  useThrottledEffect(
    () => {
      if (settings.enabled) {
        if (isGameOver) {
          if (engine.type === "local") {
            stopEngine(engine, activeTab!);
          }
        } else {
          const options =
            settings.settings?.map((s) => ({
              name: s.name,
              value: s.value?.toString() || "",
            })) ?? [];
          // Opening position: show the stored evaluation at once while the engine starts.
          const key = `${searchingFen}:${searchingMoves.join(",")}`;
          const target = useCache ? fenAfter(searchingFen, searchingMoves) : null;
          stored.current = target && isOpeningFen(target) ? { key, fen: target, depth: 0 } : null;
          if (stored.current) {
            const pending = stored.current;
            commands.evalCacheGet(pending.fen).then((r) => {
              if (stored.current !== pending || r.status !== "ok" || !r.data?.lines.length) return;
              // With fewer stored lines than asked for, the engine takes over as soon
              // as its lines are worth showing (depth 20), instead of beyond the stored depth.
              const wanted = Number(
                settings.settings?.find((o) => o.name === "MultiPV")?.value ?? 1,
              );
              pending.depth =
                r.data.lines.length >= wanted
                  ? r.data.depth
                  : Math.min(r.data.depth, MIN_STORED_DEPTH - 1);
              const lines = toBestMoves(r.data);
              setEngineVariation((prev) => new Map(prev).set(key, lines));
              if (firstEngineWithLines === engine.id || firstEngineWithLines === null)
                setScore(lines[0].score);
            });
          }
          getBestMoves(activeTab!, settings.go, {
            moves: searchingMoves,
            fen: searchingFen,
            extraOptions: options,
          }).then((moves) => {
            if (moves) {
              const [progress, bestMoves] = moves;
              setEngineVariation((prev) => {
                const newMap = new Map(prev);
                newMap.set(`${searchingFen}:${searchingMoves.join(",")}`, bestMoves);
                return newMap;
              });
              setProgress(progress);
            }
          });
        }
      } else {
        if (engine.type === "local") {
          stopEngine(engine, activeTab!);
        }
      }
    },
    50,
    [
      settings.enabled,
      JSON.stringify(settings.settings),
      settings.go,
      searchingFen,
      JSON.stringify(searchingMoves),
      isGameOver,
      activeTab,
      getBestMoves,
      setEngineVariation,
      engine,
    ],
  );
  return null;
}

export default EvalListener;
