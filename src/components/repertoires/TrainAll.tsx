import {
  Badge,
  Box,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import type { DrawShape } from "@lichess-org/chessground/draw";
import { makeSquare, type NormalMove, parseSquare } from "chessops";
import { normalizeMove } from "chessops/chess";
import { chessgroundDests, chessgroundMove } from "chessops/compat";
import { makeFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { getDefaultStore } from "jotai";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import { Chessground } from "@/chessground/Chessground";
import {
  buildFromTree,
  formatReviewInterval,
  getNextReviewTimes,
  getStats,
  type PracticeData,
  syncDeck,
  updateCardPerformance,
} from "@/components/files/opening";
import { deckAtomFamily } from "@/state/atoms";
import { parsePGN } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import { decksOfFile } from "@/utils/practiceDecks";
import { scheduleSync } from "@/utils/sync";
import { findFen, type TreeNode } from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";

export type TrainAllFile = { path: string; name: string };

type Source = {
  file: TrainAllFile;
  root: TreeNode;
  orientation: "white" | "black";
};

type Item = { path: string; fen: string };

type Phase =
  | { kind: "waiting" }
  | { kind: "correct"; san: string; move: NormalMove }
  | { kind: "incorrect"; played: string; answer: NormalMove | null };

const PRACTICE_SYNC_DELAY = 30_000;
const SYMBOLS = new Set(["!!", "!", "!?", "?!", "?", "??"]);

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function withSymbols(node: TreeNode | undefined, san: string) {
  return san + (node?.annotations ?? []).filter((a) => SYMBOLS.has(a)).join("");
}

/** Loads every repertoire (first game) and brings its practice deck in line with the PGN. */
async function loadSources(files: TrainAllFile[]) {
  const sources: Record<string, Source> = {};
  const decks: Record<string, PracticeData> = {};
  const store = getDefaultStore();
  for (const file of files) {
    try {
      const pgn = unwrap(await commands.readGames(file.path, 0, 0))[0] ?? "";
      const tree = await parsePGN(pgn);
      const orientation = tree.headers.orientation === "black" ? "black" : "white";
      const start = tree.headers.start ?? [];
      const existing = decksOfFile(file.path)[0];
      let deck: PracticeData;
      if (!existing || existing.positions.length === 0) {
        deck = {
          positions: buildFromTree(tree.root, orientation, start),
          logs: existing?.logs ?? [],
        };
        if (deck.positions.length > 0)
          store.set(deckAtomFamily({ file: file.path, game: 0 }), deck);
      } else {
        const { positions, added, removed } = syncDeck(
          existing.positions,
          tree.root,
          orientation,
          start,
        );
        deck = { ...existing, positions };
        if (added > 0 || removed > 0) store.set(deckAtomFamily({ file: file.path, game: 0 }), deck);
      }
      sources[file.path] = { file, root: tree.root, orientation };
      decks[file.path] = deck;
    } catch {
      // Unreadable file: skip it.
    }
  }
  return { sources, decks };
}

function dueItems(decks: Record<string, PracticeData>): Item[] {
  const now = new Date();
  const items: Item[] = [];
  for (const [path, deck] of Object.entries(decks)) {
    for (const p of deck.positions)
      if (new Date(p.card.due) <= now) items.push({ path, fen: p.fen });
  }
  return shuffle(items);
}

function TrainAllSession({ files, onClose }: { files: TrainAllFile[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [sources, setSources] = useState<Record<string, Source> | null>(null);
  const [decks, setDecks] = useState<Record<string, PracticeData>>({});
  const decksRef = useRef(decks);
  const [queue, setQueue] = useState<Item[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "waiting" });
  const [session, setSession] = useState({ correct: 0, incorrect: 0 });

  useEffect(() => {
    let cancelled = false;
    loadSources(files).then((loaded) => {
      if (cancelled) return;
      decksRef.current = loaded.decks;
      setDecks(loaded.decks);
      setSources(loaded.sources);
      setQueue(dueItems(loaded.decks));
    });
    return () => {
      cancelled = true;
    };
  }, [files]);

  const current = queue[0];
  const source = current && sources ? sources[current.path] : undefined;
  const deck = current ? decks[current.path] : undefined;
  const index = current && deck ? deck.positions.findIndex((p) => p.fen === current.fen) : -1;
  const position = deck && index >= 0 ? deck.positions[index] : null;

  const save = (path: string, next: PracticeData) => {
    const all = { ...decksRef.current, [path]: next };
    decksRef.current = all;
    setDecks(all);
    getDefaultStore().set(deckAtomFamily({ file: path, game: 0 }), next);
    scheduleSync(PRACTICE_SYNC_DELAY, path);
  };

  const rate = (grade: 1 | 2 | 3 | 4) => {
    if (!current || !deck || index < 0) return;
    let next = deck;
    updateCardPerformance(
      (action) => {
        next = typeof action === "function" ? action(structuredClone(deck)) : action;
      },
      index,
      deck.positions[index].card,
      grade,
    );
    save(current.path, next);
  };

  const advance = () => {
    setPhase({ kind: "waiting" });
    const rest = queue.slice(1);
    // Positions answered "again" come back once they are due.
    setQueue(rest.length > 0 ? rest : dueItems(decksRef.current));
  };

  const grade = (g: 1 | 2 | 3 | 4) => {
    if (phase.kind !== "correct") return;
    rate(g);
    advance();
  };

  useHotkeys([
    ["1", () => grade(1)],
    ["2", () => grade(2)],
    ["3", () => grade(3)],
    ["4", () => grade(4)],
    ["Enter", () => phase.kind === "incorrect" && advance()],
  ]);

  if (!sources) {
    return (
      <Center h="60vh">
        <Stack align="center">
          <Loader />
          <Text c="dimmed">{t("TrainAll.Loading")}</Text>
        </Stack>
      </Center>
    );
  }

  const stats = getStats(Object.values(decks).flatMap((d) => d.positions));

  if (!position || !source) {
    return (
      <Center h="60vh">
        <Stack align="center" gap="sm">
          <Title order={3}>{t("TrainAll.Done")}</Title>
          <Text c="dimmed">
            {t("TrainAll.SessionResult", {
              correct: session.correct,
              incorrect: session.incorrect,
            })}
          </Text>
          {stats.nextDue && (
            <Text c="dimmed" size="sm">
              {t("TrainAll.NextReview", { date: stats.nextDue.toLocaleString() })}
            </Text>
          )}
          <Button mt="md" onClick={onClose}>
            {t("TrainAll.Close")}
          </Button>
        </Stack>
      </Center>
    );
  }

  const path = findFen(position.fen, source.root);
  const nodes: TreeNode[] = [source.root];
  for (const i of path) nodes.push(nodes[nodes.length - 1].children[i]);
  const lastNode = nodes.length > 1 ? nodes[nodes.length - 1] : undefined;
  const answerNode = nodes[nodes.length - 1].children.find((c) => c.san === position.answer);

  const [pos] = positionFromFen(position.fen);
  const turn = pos?.turn ?? "white";
  let fen = position.fen;
  let lastMove = lastNode?.move ? chessgroundMove(lastNode.move) : undefined;
  const shapes: DrawShape[] = [];
  if (phase.kind === "correct" && pos) {
    const after = pos.clone();
    after.play(phase.move);
    fen = makeFen(after.toSetup());
    lastMove = chessgroundMove(phase.move);
  }
  if (phase.kind === "incorrect" && phase.answer) {
    shapes.push({
      orig: makeSquare(phase.answer.from),
      dest: makeSquare(phase.answer.to),
      brush: "green",
    });
  }

  function onMove(raw: NormalMove) {
    if (!pos || !position || phase.kind !== "waiting") return;
    const answerMove = parseSan(pos, position.answer) as NormalMove | undefined;
    let move = normalizeMove(pos, raw) as NormalMove;
    const piece = pos.board.get(move.from);
    const rank = Math.floor(move.to / 8);
    if (piece?.role === "pawn" && (rank === 0 || rank === 7)) {
      const promotion =
        answerMove && answerMove.from === move.from && answerMove.to === move.to
          ? answerMove.promotion
          : "queen";
      move = { ...move, promotion };
    }
    if (!pos.isLegal(move)) return;
    const san = makeSan(pos, move);
    if (san === position.answer) {
      setSession((s) => ({ ...s, correct: s.correct + 1 }));
      setPhase({ kind: "correct", san, move });
    } else {
      setSession((s) => ({ ...s, incorrect: s.incorrect + 1 }));
      rate(1);
      setPhase({ kind: "incorrect", played: san, answer: answerMove ?? null });
    }
  }

  const reviewTimes = phase.kind === "correct" ? getNextReviewTimes(position.card) : null;
  const moveText = nodes
    .slice(1)
    .map((n, i) => {
      const white = n.halfMoves % 2 === 1;
      const num = Math.ceil(n.halfMoves / 2);
      return `${white ? `${num}. ` : i === 0 ? `${num}... ` : ""}${withSymbols(n, n.san ?? "")}`;
    })
    .join(" ");
  const notes = [
    lastNode ? { label: withSymbols(lastNode, lastNode.san ?? ""), text: lastNode.comment } : null,
    { label: withSymbols(answerNode, position.answer), text: answerNode?.comment ?? "" },
  ].filter((n): n is { label: string; text: string } => !!n && !!n.text?.trim());

  const gradeLabels: Record<1 | 2 | 3 | 4, { label: string; color: string }> = {
    1: { label: t("TrainAll.Again"), color: "red" },
    2: { label: t("TrainAll.Hard"), color: "orange" },
    3: { label: t("TrainAll.Good"), color: "teal" },
    4: { label: t("TrainAll.Easy"), color: "blue" },
  };

  return (
    <Group align="flex-start" gap="xl" wrap="nowrap" p="md" h="100%">
      <Box w="min(calc(100vh - 140px), 60vw)" style={{ flexShrink: 0 }}>
        <Chessground
          fen={fen}
          orientation={source.orientation}
          turnColor={phase.kind === "correct" ? (turn === "white" ? "black" : "white") : turn}
          lastMove={lastMove}
          check={pos?.isCheck() && phase.kind === "waiting"}
          animation={{ enabled: true }}
          movable={{
            free: false,
            color: phase.kind === "waiting" ? turn : undefined,
            dests: phase.kind === "waiting" && pos ? chessgroundDests(pos) : new Map(),
            showDests: true,
            events: {
              after: (orig, dest) => {
                const from = parseSquare(orig);
                const to = parseSquare(dest);
                if (from !== undefined && to !== undefined) onMove({ from, to });
              },
            },
          }}
          drawable={{ enabled: true, visible: true, autoShapes: shapes }}
        />
      </Box>

      <ScrollArea style={{ flex: 1 }} h="100%">
        <Stack gap="md" maw={520}>
          <Group gap="xs">
            <Badge color="orange" variant="light">
              {t("Repertoires.Due", { count: stats.due })}
            </Badge>
            <Badge color="blue" variant="light">
              {t("Repertoires.NewPositions", { count: stats.unseen })}
            </Badge>
            <Badge color="gray" variant="light">
              {t("TrainAll.InQueue", { count: queue.length })}
            </Badge>
          </Group>

          <Paper withBorder p="md" radius="md">
            <Group gap="sm">
              <Box
                w={16}
                h={16}
                style={{
                  borderRadius: "50%",
                  border: "2px solid var(--mantine-color-gray-5)",
                  background: source.orientation === "black" ? "#000" : "#fff",
                }}
              />
              <Text fw={600}>{source.file.name}</Text>
            </Group>
            <Text size="sm" c="dimmed" mt={6}>
              {moveText || t("TrainAll.StartPosition")}
            </Text>
          </Paper>

          {phase.kind === "waiting" && (
            <Text>
              {t("TrainAll.Prompt", {
                color: source.orientation === "white" ? t("Common.WHITE") : t("Common.BLACK"),
              })}
            </Text>
          )}

          {phase.kind === "incorrect" && (
            <Stack gap="xs">
              <Text>
                {t("TrainAll.Wrong", { played: phase.played })}{" "}
                <Text span fw={700} c="teal">
                  {withSymbols(answerNode, position.answer)}
                </Text>
              </Text>
              <Group>
                <Button onClick={advance}>{t("TrainAll.Next")}</Button>
              </Group>
            </Stack>
          )}

          {phase.kind === "correct" && reviewTimes && (
            <Stack gap="xs">
              <Text>
                <Text span fw={700} c="teal">
                  {withSymbols(answerNode, phase.san)}
                </Text>{" "}
                — {t("TrainAll.Correct")}
              </Text>
              <SimpleGrid cols={4} spacing="xs">
                {([1, 2, 3, 4] as const).map((g) => (
                  <Button
                    key={g}
                    variant="light"
                    color={gradeLabels[g].color}
                    onClick={() => grade(g)}
                    h={56}
                  >
                    <Stack gap={0} align="center">
                      <span>
                        {g}. {gradeLabels[g].label}
                      </span>
                      <Text size="xs" c="dimmed">
                        {formatReviewInterval(reviewTimes[g])}
                      </Text>
                    </Stack>
                  </Button>
                ))}
              </SimpleGrid>
            </Stack>
          )}

          {phase.kind !== "waiting" &&
            notes.map((n) => (
              <Paper
                key={n.label}
                p="sm"
                radius="md"
                withBorder
                style={{ borderLeft: "3px solid var(--mantine-primary-color-filled)" }}
              >
                <Text size="sm">
                  <Text span fw={700} c="blue">
                    {n.label}
                  </Text>{" "}
                  {n.text}
                </Text>
              </Paper>
            ))}

          <Text size="sm" c="dimmed">
            {t("TrainAll.SessionResult", {
              correct: session.correct,
              incorrect: session.incorrect,
            })}
          </Text>
        </Stack>
      </ScrollArea>
    </Group>
  );
}

/** Full-screen "Train all" session: due positions of every repertoire, shuffled. */
export default function TrainAll({
  opened,
  files,
  onClose,
}: {
  opened: boolean;
  files: TrainAllFile[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal opened={opened} onClose={onClose} fullScreen title={t("TrainAll.Title")} closeOnEscape>
      {opened && <TrainAllSession files={files} onClose={onClose} />}
    </Modal>
  );
}
