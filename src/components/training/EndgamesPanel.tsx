import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Key } from "@lichess-org/chessground/types";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconBulb,
  IconCheck,
  IconPlayerPlay,
  IconRefresh,
  IconArrowRight,
  IconX,
} from "@tabler/icons-react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { parseUci } from "chessops";
import { Chess } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import dayjs from "dayjs";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { trainingProgressAtom, updateTrainingProgress } from "@/state/training";
import {
  EndgameRun,
  type MoveOutcome,
  type RunStatus,
  tablebaseProbe,
  type Verdict,
} from "@/utils/training/endgameRun";
import { CHAPTERS, type Endgame, ENDGAMES, endgameById } from "@/utils/training/endgames";
import { numberedMoves } from "@/utils/training/notation";
import { isDue, isNew, type Outcome, reviewExercise } from "@/utils/training/srs";
import { TrainingBoard } from "./TrainingBoard";
import classes from "./training.module.css";

const probe = tablebaseProbe(tauriFetch as typeof fetch);

/** "Vinci fino al matto (max 20 mosse)", "Tieni la patta per 15 mosse"… */
export function useGoalText() {
  const { t } = useTranslation();
  return useCallback(
    (ex: Endgame) => {
      if (ex.goal === "draw") return t("Training.Endgames.GoalDraw", { n: ex.hold ?? 12 });
      const stop = ex.stop ?? "mate";
      return t(`Training.Endgames.GoalWin.${stop}`, { n: ex.limit ?? 40 });
    },
    [t],
  );
}

function afterMove(fen: string, uci: string): string | null {
  const pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
  const move = parseUci(uci);
  if (!move || !pos.isLegal(move)) return null;
  pos.play(move);
  return makeFen(pos.toSetup());
}

const squares = (uci: string): [string, string] => [uci.slice(0, 2), uci.slice(2, 4)];

function EndgamePlayer({
  exercise,
  onRecorded,
}: {
  exercise: Endgame;
  onRecorded: (ok: boolean) => void;
}) {
  const { t } = useTranslation();
  const goalText = useGoalText();
  const runRef = useRef<EndgameRun>(null);
  if (runRef.current === null) runRef.current = new EndgameRun(exercise, probe);
  const user = exercise.fen.split(" ")[1] === "b" ? "black" : "white";
  const [fen, setFen] = useState(exercise.fen);
  // What the run looks like, mirrored in state (the run itself is mutable).
  const [moves, setMoves] = useState<string[]>([]);
  const [status, setStatus] = useState<RunStatus>("playing");
  const [lastMove, setLastMove] = useState<[string, string] | undefined>();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<MoveOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startCheck, setStartCheck] = useState<Verdict | "error" | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [hintUsed, setHintUsed] = useState(false);
  const [attempt, setAttempt] = useState(1);
  const recorded = useRef(false);

  const restart = useCallback(() => {
    runRef.current = new EndgameRun(exercise, probe);
    setFen(exercise.fen);
    setMoves([]);
    setStatus("playing");
    setLastMove(undefined);
    setOutcome(null);
    setError(null);
    setHint(null);
    setBusy(false);
  }, [exercise]);

  useEffect(() => {
    let live = true;
    runRef.current
      ?.startVerdict()
      .then((v) => live && setStartCheck(v))
      .catch((e) => {
        if (!live) return;
        setStartCheck("error");
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, []);

  const record = (ok: boolean) => {
    if (recorded.current) return;
    recorded.current = true;
    const result: Outcome = !ok ? "again" : hintUsed || attempt > 1 ? "hard" : "good";
    updateTrainingProgress((p) => ({
      ...p,
      endgames: {
        ...p.endgames,
        [exercise.id]: reviewExercise(p.endgames[exercise.id], result),
      },
    }));
    onRecorded(ok);
  };

  const play = async (uci: string) => {
    const run = runRef.current;
    if (!run || busy || run.status !== "playing") return;
    const shown = afterMove(fen, uci);
    if (!shown) return;
    setFen(shown);
    setLastMove(squares(uci));
    setHint(null);
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
  const movable = !busy && !finished && !stuck && turn === user;
  const shapes: DrawShape[] = hint
    ? [{ orig: hint.slice(0, 2) as Key, dest: hint.slice(2, 4) as Key, brush: "blue" }]
    : [];
  const mismatch =
    startCheck &&
    startCheck !== "error" &&
    startCheck !== "unknown" &&
    startCheck !== exercise.goal;

  return (
    <Group align="stretch" wrap="nowrap" gap="lg" h="100%">
      <div className={classes.boardArea}>
        <TrainingBoard
          fen={fen}
          orientation={user}
          movable={movable}
          onMove={play}
          lastMove={lastMove}
          shapes={shapes}
        />
      </div>
      <Stack w={360} gap="sm">
        <Title order={4}>{exercise.title}</Title>
        <Group gap="xs">
          <Badge color={exercise.goal === "win" ? "teal" : "blue"} variant="light">
            {goalText(exercise)}
          </Badge>
          <Badge color="gray" variant="outline">
            {t("Training.Endgames.YouPlay", { side: t(`Training.Side.${user}`) })}
          </Badge>
        </Group>
        <Text size="sm">{exercise.idea}</Text>
        {mismatch && (
          <Alert color="yellow" icon={<IconAlertTriangle />}>
            {t("Training.Endgames.Mismatch", {
              result: t(`Training.Endgames.Verdict.${startCheck}`),
            })}
          </Alert>
        )}
        {moves.length > 0 && (
          <Text size="sm" ff="monospace">
            {numberedMoves(exercise.fen, moves)}
          </Text>
        )}
        {busy && (
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="sm" c="dimmed">
              {t("Training.Endgames.Thinking")}
            </Text>
          </Group>
        )}
        {error && (
          <Alert color="red" icon={<IconAlertTriangle />}>
            {error}
          </Alert>
        )}
        {outcome?.status === "playing" && outcome.message && (
          <Text size="sm" c="orange">
            {outcome.message}
          </Text>
        )}
        {outcome?.status === "success" && (
          <Alert color="green" icon={<IconCheck />}>
            {outcome.message}
          </Alert>
        )}
        {outcome?.status === "failed" && (
          <Alert color="red" icon={<IconX />}>
            <Text size="sm">{outcome.message}</Text>
            {outcome.better && (
              <Text size="sm" mt={4}>
                {t("Training.Endgames.Better", { move: outcome.better })}
              </Text>
            )}
          </Alert>
        )}
        <Group>
          {!finished && !stuck && (
            <Button
              variant="light"
              leftSection={<IconBulb size="1rem" />}
              disabled={!movable}
              onClick={showHint}
            >
              {t("Training.Endgames.Hint")}
            </Button>
          )}
          {(finished || stuck || moves.length > 0) && (
            <Button
              variant={finished || stuck ? "filled" : "default"}
              leftSection={<IconRefresh size="1rem" />}
              onClick={() => {
                setAttempt((a) => a + 1);
                restart();
              }}
            >
              {t("Training.Retry")}
            </Button>
          )}
        </Group>
        {hintUsed && !finished && (
          <Text size="xs" c="dimmed">
            {t("Training.Endgames.HintNote")}
          </Text>
        )}
      </Stack>
    </Group>
  );
}

function EndgameSession({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [results, setResults] = useState<Record<string, boolean>>({});
  const exercise = endgameById(ids[index]);

  if (!exercise) {
    const ok = Object.values(results).filter(Boolean).length;
    return (
      <Card withBorder p="xl">
        <Stack align="center">
          <Title order={3}>{t("Training.Endgames.Done")}</Title>
          <Text>{t("Training.Endgames.Score", { ok, total: Object.keys(results).length })}</Text>
          <Button onClick={onDone}>{t("Training.Back")}</Button>
        </Stack>
      </Card>
    );
  }

  const last = index === ids.length - 1;
  const done = exercise.id in results;

  return (
    <Stack h="100%" gap="sm">
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {t("Training.Endgames.Progress", { n: index + 1, total: ids.length })}
        </Text>
        <Group gap="xs">
          <Button
            size="xs"
            variant={done ? "filled" : "subtle"}
            rightSection={<IconArrowRight size="0.9rem" />}
            onClick={() => setIndex((i) => i + 1)}
          >
            {last ? t("Training.Finish") : done ? t("Training.Next") : t("Training.Skip")}
          </Button>
          <Button size="xs" variant="subtle" color="gray" onClick={onDone}>
            {t("Training.Stop")}
          </Button>
        </Group>
      </Group>
      <div style={{ flex: 1, minHeight: 0 }}>
        <EndgamePlayer
          key={exercise.id}
          exercise={exercise}
          onRecorded={(ok) => setResults((r) => ({ ...r, [exercise.id]: ok }))}
        />
      </div>
    </Stack>
  );
}

export function EndgamesPanel() {
  const { t } = useTranslation();
  const goalText = useGoalText();
  const progress = useAtomValue(trainingProgressAtom).endgames;
  const [session, setSession] = useState<string[] | null>(null);
  const due = useMemo(
    () => ENDGAMES.filter((e) => isDue(progress[e.id])).map((e) => e.id),
    [progress],
  );

  if (session) return <EndgameSession ids={session} onDone={() => setSession(null)} />;

  return (
    <Stack gap="lg">
      <Text c="dimmed" size="sm">
        {t("Training.Endgames.Intro")}
      </Text>
      <Group>
        <Button
          leftSection={<IconPlayerPlay size="1rem" />}
          disabled={due.length === 0}
          onClick={() => setSession(due)}
        >
          {due.length
            ? t("Training.Endgames.ReviewDue", { n: due.length })
            : t("Training.Endgames.NoneDue")}
        </Button>
      </Group>
      {CHAPTERS.map((chapter) => {
        const list = ENDGAMES.filter((e) => e.chapter === chapter.id);
        const solved = list.filter((e) => progress[e.id]?.history.some((a) => a.ok)).length;
        return (
          <Stack key={chapter.id} gap="xs">
            <Group justify="space-between">
              <Group gap="xs">
                <Title order={4}>{chapter.title}</Title>
                <Badge variant="light" color={solved === list.length ? "teal" : "gray"}>
                  {solved}/{list.length}
                </Badge>
              </Group>
              <Button
                size="xs"
                variant="subtle"
                leftSection={<IconPlayerPlay size="0.9rem" />}
                onClick={() => setSession(list.map((e) => e.id))}
              >
                {t("Training.Endgames.PlayChapter")}
              </Button>
            </Group>
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
              {list.map((ex) => {
                const p = progress[ex.id];
                const last = p?.history.at(-1);
                return (
                  <Card
                    key={ex.id}
                    withBorder
                    p="sm"
                    style={{ cursor: "pointer" }}
                    onClick={() => setSession([ex.id])}
                  >
                    <Group justify="space-between" wrap="nowrap" align="flex-start">
                      <Text fw={600} size="sm">
                        {ex.title}
                      </Text>
                      {isNew(p) ? (
                        <Badge size="xs" variant="light" color="gray">
                          {t("Training.New")}
                        </Badge>
                      ) : isDue(p) ? (
                        <Badge size="xs" variant="light" color="orange">
                          {t("Training.Due")}
                        </Badge>
                      ) : (
                        <Badge size="xs" variant="light" color={last?.ok ? "teal" : "red"}>
                          {t("Training.NextReview", { date: dayjs(p!.card.due).format("DD/MM") })}
                        </Badge>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed" mt={4}>
                      {goalText(ex)}
                    </Text>
                  </Card>
                );
              })}
            </SimpleGrid>
          </Stack>
        );
      })}
    </Stack>
  );
}
