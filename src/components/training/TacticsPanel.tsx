import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Key } from "@lichess-org/chessground/types";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  NumberInput,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconArrowRight, IconCheck, IconPlayerPlay, IconX } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { parseUci } from "chessops";
import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import dayjs from "dayjs";
import { useAtom, useAtomValue } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  setTacticsPack,
  tacticsPackAtom,
  trainingProgressAtom,
  updateTrainingProgress,
} from "@/state/training";
import { planSession, progressStats, reviewExercise } from "@/utils/training/srs";
import { buildTactics, isGoodAnswer, type Tactic } from "@/utils/training/tactics";
import { loadStatsEvals, statsEvalsAtom } from "../stats/analysisRunner";
import { pawns } from "../stats/StatsEngine";
import { loadStatsGames, statsGamesAtom } from "../stats/statsStore";
import { analyseCandidates } from "./engineEval";
import { TrainingBoard } from "./TrainingBoard";
import classes from "./training.module.css";

export const tacticsSettingsAtom = atomWithStorage(
  "training-tactics-settings",
  { newPerDay: 10 },
  undefined,
  { getOnInit: true },
);

/** Keeps the tactics pack (also sent to the phone) in step with the analysed games. */
function useTacticsFromGames() {
  const data = useAtomValue(statsGamesAtom);
  const evals = useAtomValue(statsEvalsAtom);
  const pack = useAtomValue(tacticsPackAtom);
  useEffect(() => {
    loadStatsGames();
    loadStatsEvals();
  }, []);
  const built = useMemo(() => {
    if (!data || !evals) return null;
    const games = Object.values(data.accounts).flatMap((a) => a.games);
    return buildTactics(games, evals);
  }, [data, evals]);
  useEffect(() => {
    if (!built) return;
    const same =
      pack &&
      pack.tactics.length === built.length &&
      pack.tactics.every((t, i) => t.id === built[i].id);
    if (!same) setTacticsPack({ version: 1, built: new Date().toISOString(), tactics: built });
  }, [built, pack]);
  return pack?.tactics ?? built ?? [];
}

type Answer =
  | { kind: "checking"; uci: string }
  | { kind: "right"; uci: string; san: string; exact: boolean }
  | { kind: "wrong"; uci: string; san: string; cp: number | null };

function sanOf(fen: string, uci: string): string {
  const pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
  const move = parseUci(uci);
  return move ? makeSan(pos, move) : uci;
}

function arrow(uci: string, brush: string): DrawShape {
  return { orig: uci.slice(0, 2) as Key, dest: uci.slice(2, 4) as Key, brush };
}

function TacticSession({
  ids,
  byId,
  onDone,
}: {
  ids: string[];
  byId: Map<string, Tactic>;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [queue, setQueue] = useState(ids);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [score, setScore] = useState({ right: 0, done: 0 });
  const [noEngine, setNoEngine] = useState(false);
  const tactic = queue.length ? byId.get(queue[0]) : undefined;

  if (!tactic) {
    return (
      <Card withBorder p="xl">
        <Stack align="center">
          <Title order={3}>{t("Training.Tactics.Done")}</Title>
          <Text>{t("Training.Tactics.Score", { right: score.right, done: score.done })}</Text>
          <Button onClick={onDone}>{t("Training.Back")}</Button>
        </Stack>
      </Card>
    );
  }

  const record = (ok: boolean) => {
    updateTrainingProgress((p) => ({
      ...p,
      tactics: {
        ...p.tactics,
        [tactic.id]: reviewExercise(p.tactics[tactic.id], ok ? "good" : "again"),
      },
    }));
    setScore((s) => ({ right: s.right + (ok ? 1 : 0), done: s.done + 1 }));
  };

  const play = async (uci: string) => {
    if (answer) return;
    const san = sanOf(tactic.fen, uci);
    if (uci === tactic.bestUci || san === tactic.best) {
      setAnswer({ kind: "right", uci, san, exact: true });
      record(true);
      return;
    }
    setAnswer({ kind: "checking", uci });
    try {
      const res = await analyseCandidates(tactic.fen, [uci], { ms: 1500, multiPv: 1 });
      if (!res) setNoEngine(true);
      const cp = res?.scores[uci] ?? null;
      if (cp !== null && isGoodAnswer(tactic.evalBest, cp)) {
        setAnswer({ kind: "right", uci, san, exact: false });
        record(true);
      } else {
        setAnswer({ kind: "wrong", uci, san, cp });
        record(false);
      }
    } catch {
      setAnswer({ kind: "wrong", uci, san, cp: null });
      record(false);
    }
  };

  const next = () => {
    setQueue((q) => {
      const [first, ...rest] = q;
      // A missed exercise comes back once at the end of the session.
      return answer?.kind === "wrong" && !rest.includes(first) ? [...rest, first] : rest;
    });
    setAnswer(null);
  };

  const shapes: DrawShape[] = [];
  if (answer && answer.kind !== "checking") {
    shapes.push(arrow(tactic.bestUci, "green"));
    if (answer.kind === "wrong") shapes.push(arrow(answer.uci, "red"));
  }
  const toMove = t(`Training.Side.${tactic.color}`);

  return (
    <Group align="stretch" wrap="nowrap" gap="lg" h="100%">
      <div className={classes.boardArea}>
        <TrainingBoard
          fen={tactic.fen}
          orientation={tactic.color}
          movable={!answer}
          onMove={play}
          shapes={shapes}
        />
      </div>
      <Stack w={340} gap="sm">
        <Group gap="xs">
          <Badge color={tactic.kind === "missed" ? "grape" : "red"} variant="light">
            {t(`Training.Tactics.Kind.${tactic.kind}`)}
          </Badge>
          <Text size="sm" c="dimmed">
            {t("Training.Tactics.Left", { n: queue.length })}
          </Text>
        </Group>
        <Text fw={600}>{t("Training.Tactics.Find", { side: toMove })}</Text>
        <Text size="sm" c="dimmed">
          {t("Training.Tactics.From", {
            opponent: tactic.opponent,
            date: dayjs(tactic.date).format("DD/MM/YYYY"),
            move: tactic.moveLabel,
          })}
        </Text>
        {answer?.kind === "checking" && <Text size="sm">{t("Training.Tactics.Checking")}</Text>}
        {answer?.kind === "right" && (
          <Alert color="green" icon={<IconCheck />}>
            {answer.exact
              ? t("Training.Tactics.Right", { move: answer.san })
              : t("Training.Tactics.AlsoGood", { move: answer.san, best: tactic.best })}
          </Alert>
        )}
        {answer?.kind === "wrong" && (
          <Alert color="red" icon={<IconX />}>
            <Text size="sm">
              {t("Training.Tactics.Wrong", {
                move: answer.san,
                best: tactic.best,
                eval: pawns(tactic.evalBest),
              })}
            </Text>
            {answer.cp !== null && (
              <Text size="xs" c="dimmed">
                {t("Training.Tactics.YourEval", { eval: pawns(answer.cp) })}
              </Text>
            )}
            {noEngine && (
              <Text size="xs" c="dimmed">
                {t("Training.Tactics.NoEngine")}
              </Text>
            )}
          </Alert>
        )}
        {answer && answer.kind !== "checking" && (
          <>
            <Text size="sm">
              {t("Training.Tactics.InGame", {
                move: tactic.played,
                eval: pawns(tactic.evalPlayed),
              })}
            </Text>
            <Group>
              <Button rightSection={<IconArrowRight size="1rem" />} onClick={next}>
                {t("Training.Next")}
              </Button>
              <Anchor size="sm" onClick={() => openUrl(tactic.url)}>
                {t("Training.OpenGame")}
              </Anchor>
            </Group>
          </>
        )}
        <Button variant="subtle" color="gray" mt="auto" onClick={onDone}>
          {t("Training.Stop")}
        </Button>
      </Stack>
    </Group>
  );
}

export function TacticsPanel() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tactics = useTacticsFromGames();
  const progress = useAtomValue(trainingProgressAtom);
  const [settings, setSettings] = useAtom(tacticsSettingsAtom);
  const [session, setSession] = useState<string[] | null>(null);
  const byId = useMemo(() => new Map(tactics.map((x) => [x.id, x])), [tactics]);
  const ids = tactics.map((x) => x.id);
  const plan = planSession(ids, progress.tactics, settings.newPerDay);
  const stats = progressStats(ids, progress.tactics);
  const missed = tactics.filter((x) => x.kind === "missed").length;

  if (session) return <TacticSession ids={session} byId={byId} onDone={() => setSession(null)} />;

  if (tactics.length === 0) {
    return (
      <Card withBorder p="xl">
        <Stack align="center" gap="sm">
          <Text ta="center" maw={560}>
            {t("Training.Tactics.Empty")}
          </Text>
          <Button variant="light" onClick={() => navigate({ to: "/statistics" })}>
            {t("Training.Tactics.GoToStats")}
          </Button>
        </Stack>
      </Card>
    );
  }

  return (
    <Stack gap="md">
      <Text c="dimmed" size="sm">
        {t("Training.Tactics.Intro")}
      </Text>
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Card withBorder p="sm">
          <Text size="xs" c="dimmed">
            {t("Training.Tactics.Total")}
          </Text>
          <Text fw={700} size="xl">
            {tactics.length}
          </Text>
          <Text size="xs" c="dimmed">
            {t("Training.Tactics.Split", { errors: tactics.length - missed, missed })}
          </Text>
        </Card>
        <Card withBorder p="sm">
          <Text size="xs" c="dimmed">
            {t("Training.Today")}
          </Text>
          <Text fw={700} size="xl">
            {plan.ids.length}
          </Text>
          <Text size="xs" c="dimmed">
            {t("Training.TodaySplit", { due: plan.due, fresh: plan.fresh })}
          </Text>
        </Card>
        <Card withBorder p="sm">
          <Text size="xs" c="dimmed">
            {t("Training.Seen")}
          </Text>
          <Text fw={700} size="xl">
            {stats.seen}
          </Text>
        </Card>
        <Card withBorder p="sm">
          <Text size="xs" c="dimmed">
            {t("Training.Success")}
          </Text>
          <Text fw={700} size="xl">
            {stats.successRate === null ? "—" : `${Math.round(stats.successRate * 100)}%`}
          </Text>
        </Card>
      </SimpleGrid>
      <Group align="flex-end">
        <Button
          leftSection={<IconPlayerPlay size="1rem" />}
          disabled={plan.ids.length === 0}
          onClick={() => setSession(plan.ids)}
        >
          {plan.ids.length
            ? t("Training.Start", { n: plan.ids.length })
            : t("Training.NothingToday")}
        </Button>
        <NumberInput
          label={t("Training.NewPerDay")}
          w={160}
          min={0}
          max={50}
          value={settings.newPerDay}
          onChange={(v) => setSettings({ newPerDay: typeof v === "number" ? v : 0 })}
        />
      </Group>
      <Text size="xs" c="dimmed">
        {t("Training.Tactics.PhoneNote")}
      </Text>
    </Stack>
  );
}
