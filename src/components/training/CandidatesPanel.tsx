import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Key } from "@lichess-org/chessground/types";
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconPlayerPlay,
  IconStar,
  IconStarFilled,
  IconX,
} from "@tabler/icons-react";
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
  buildMoments,
  type CandidateAttempt,
  type CandidateVerdict,
  judgeCandidate,
  type Moment,
  type MomentKind,
  summarizeAttempts,
} from "@/utils/training/candidates";
import { numberedMoves } from "@/utils/training/notation";
import { loadStatsEvals, statsEvalsAtom } from "../stats/analysisRunner";
import { pawns } from "../stats/StatsEngine";
import { loadStatsGames, statsGamesAtom } from "../stats/statsStore";
import { analyseCandidates, type EngineLine, stopTrainingEngine } from "./engineEval";
import { TrainingBoard } from "./TrainingBoard";
import classes from "./training.module.css";

const MAX_CANDIDATES = 3;
const HISTORY = 1000;

export const candidatesHistoryAtom = atomWithStorage<CandidateAttempt[]>(
  "training-candidates-history",
  [],
  undefined,
  { getOnInit: true },
);

type Filter = "all" | MomentKind;

const VERDICT_COLOR: Record<CandidateVerdict, string> = {
  best: "teal",
  good: "green",
  inaccuracy: "yellow",
  mistake: "orange",
  blunder: "red",
};

const BRUSH: Record<CandidateVerdict, string> = {
  best: "green",
  good: "blue",
  inaccuracy: "yellow",
  mistake: "red",
  blunder: "red",
};

function useMoments(): Moment[] | null {
  const data = useAtomValue(statsGamesAtom);
  const evals = useAtomValue(statsEvalsAtom);
  useEffect(() => {
    loadStatsGames();
    loadStatsEvals();
  }, []);
  return useMemo(() => {
    if (!data || !evals) return null;
    const games = Object.values(data.accounts).flatMap((a) => a.games);
    return buildMoments(games, evals);
  }, [data, evals]);
}

function sanOf(fen: string, uci: string): string {
  const pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
  const move = parseUci(uci);
  return move ? makeSan(pos, move) : uci;
}

const arrow = (uci: string, brush: string): DrawShape => ({
  orig: uci.slice(0, 2) as Key,
  dest: uci.slice(2, 4) as Key,
  brush,
});

type Result = {
  lines: EngineLine[];
  rows: { uci: string; san: string; cp: number; verdict: CandidateVerdict }[];
  foundBest: boolean;
};

function MomentExercise({
  moment,
  left,
  onNext,
  onStop,
}: {
  moment: Moment;
  left: number;
  onNext: () => void;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  const [, setHistory] = useAtom(candidatesHistoryAtom);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => stopTrainingEngine(), []);

  const add = (uci: string) => {
    if (result || checking) return;
    setCandidates((c) => (c.includes(uci) || c.length >= MAX_CANDIDATES ? c : [...c, uci]));
  };

  const verify = async () => {
    setChecking(true);
    setError(null);
    try {
      const res = await analyseCandidates(moment.fen, candidates, { ms: 2000, multiPv: 3 });
      if (!res) {
        setError(t("Training.Candidates.NoEngine"));
        return;
      }
      const top = res.lines[0];
      const bestCp = top?.cp ?? Math.max(...Object.values(res.scores));
      const rows = candidates.map((uci) => {
        const cp = res.scores[uci] ?? bestCp;
        const isBest = top ? uci === top.uci[0] || cp >= top.cp : false;
        return {
          uci,
          san: sanOf(moment.fen, uci),
          cp,
          verdict: judgeCandidate(bestCp, cp, isBest),
        };
      });
      const foundBest = rows.some((r) => r.verdict === "best");
      setResult({ lines: res.lines, rows, foundBest });
      setHistory((h) =>
        [
          ...h.filter((a) => a.id !== moment.id),
          {
            id: moment.id,
            at: new Date().toISOString(),
            candidates,
            foundBest,
            choice: rows[0].verdict,
          },
        ].slice(-HISTORY),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  const shapes: DrawShape[] = [];
  if (result) {
    const top = result.lines[0]?.uci[0];
    if (top) shapes.push(arrow(top, "green"));
    for (const row of result.rows)
      if (row.uci !== top) shapes.push(arrow(row.uci, BRUSH[row.verdict]));
  } else {
    candidates.forEach((uci, i) => shapes.push(arrow(uci, i === 0 ? "paleGreen" : "paleBlue")));
  }

  const choose = (uci: string) => setCandidates((c) => [uci, ...c.filter((x) => x !== uci)]);
  const remove = (uci: string) => setCandidates((c) => c.filter((x) => x !== uci));
  const side = t(`Training.Side.${moment.color}`);

  return (
    <Group align="stretch" wrap="nowrap" gap="lg" h="100%">
      <div className={classes.boardArea}>
        <TrainingBoard
          fen={moment.fen}
          orientation={moment.color}
          movable={!result && !checking && candidates.length < MAX_CANDIDATES}
          onMove={add}
          shapes={shapes}
        />
      </div>
      <Stack w={380} gap="sm">
        <Group gap="xs">
          <Badge
            variant="light"
            color={
              moment.kind === "punished" ? "teal" : moment.kind === "missed" ? "grape" : "orange"
            }
          >
            {t(`Training.Candidates.Kind.${moment.kind}`)}
          </Badge>
          <Text size="sm" c="dimmed">
            {t("Training.Candidates.Left", { n: left })}
          </Text>
        </Group>
        <Text size="sm" c="dimmed">
          {t("Training.Tactics.From", {
            opponent: moment.opponent,
            date: dayjs(moment.date).format("DD/MM/YYYY"),
            move: moment.moveLabel,
          })}
        </Text>
        {!result && (
          <Text fw={600} size="sm">
            {t("Training.Candidates.Ask", { side, n: MAX_CANDIDATES })}
          </Text>
        )}
        {!result && candidates.length > 0 && (
          <Stack gap={4}>
            {candidates.map((uci, i) => (
              <Group key={uci} gap="xs" wrap="nowrap">
                <Tooltip label={t("Training.Candidates.Choose")}>
                  <ActionIcon
                    variant="subtle"
                    color="yellow"
                    onClick={() => choose(uci)}
                    disabled={checking}
                  >
                    {i === 0 ? <IconStarFilled size="1rem" /> : <IconStar size="1rem" />}
                  </ActionIcon>
                </Tooltip>
                <Text fw={i === 0 ? 700 : 400}>{sanOf(moment.fen, uci)}</Text>
                {i === 0 && (
                  <Text size="xs" c="dimmed">
                    {t("Training.Candidates.MyChoice")}
                  </Text>
                )}
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  ml="auto"
                  onClick={() => remove(uci)}
                  disabled={checking}
                >
                  <IconX size="1rem" />
                </ActionIcon>
              </Group>
            ))}
          </Stack>
        )}
        {!result && (
          <Button
            onClick={verify}
            disabled={candidates.length === 0 || checking}
            leftSection={checking ? <Loader size="xs" /> : <IconCheck size="1rem" />}
          >
            {checking ? t("Training.Candidates.Checking") : t("Training.Candidates.Verify")}
          </Button>
        )}
        {error && (
          <Alert color="red" icon={<IconAlertTriangle />}>
            {error}
          </Alert>
        )}
        {result && (
          <>
            <Alert
              color={result.foundBest ? "green" : "orange"}
              icon={result.foundBest ? <IconCheck /> : <IconAlertTriangle />}
            >
              {result.foundBest
                ? t("Training.Candidates.FoundBest")
                : t("Training.Candidates.MissedBest", {
                    move: result.lines[0]?.san[0] ?? moment.best,
                  })}
            </Alert>
            <Table withRowBorders={false} verticalSpacing={4}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("Training.Candidates.YourMoves")}</Table.Th>
                  <Table.Th>{t("Training.Candidates.Eval")}</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {result.rows.map((row, i) => (
                  <Table.Tr key={row.uci}>
                    <Table.Td fw={i === 0 ? 700 : 400}>
                      {row.san}
                      {i === 0 && " ★"}
                    </Table.Td>
                    <Table.Td>{pawns(row.cp)}</Table.Td>
                    <Table.Td>
                      <Badge size="sm" variant="light" color={VERDICT_COLOR[row.verdict]}>
                        {t(`Training.Candidates.Verdict.${row.verdict}`)}
                      </Badge>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <Text size="sm" fw={600}>
              {t("Training.Candidates.EngineLines")}
            </Text>
            <Stack gap={4}>
              {result.lines.map((line) => (
                <Group key={line.uci.join(" ")} gap="xs" wrap="nowrap" align="flex-start">
                  <Badge variant="outline" color="gray" w={56} style={{ flexShrink: 0 }}>
                    {pawns(line.cp)}
                  </Badge>
                  <Text size="sm" ff="monospace" lineClamp={2}>
                    {numberedMoves(moment.fen, line.san.slice(0, 8))}
                  </Text>
                </Group>
              ))}
            </Stack>
            <Text size="sm">
              {t("Training.Tactics.InGame", {
                move: moment.played,
                eval: pawns(moment.evalPlayed),
              })}
            </Text>
            <Group>
              <Button rightSection={<IconArrowRight size="1rem" />} onClick={onNext}>
                {t("Training.Next")}
              </Button>
              <Anchor size="sm" onClick={() => openUrl(moment.url)}>
                {t("Training.OpenGame")}
              </Anchor>
            </Group>
          </>
        )}
        <Group mt="auto">
          {!result && (
            <Button variant="subtle" onClick={onNext} disabled={checking}>
              {t("Training.Skip")}
            </Button>
          )}
          <Button variant="subtle" color="gray" onClick={onStop}>
            {t("Training.Stop")}
          </Button>
        </Group>
      </Stack>
    </Group>
  );
}

export function CandidatesPanel() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const moments = useMoments();
  const history = useAtomValue(candidatesHistoryAtom);
  const [filter, setFilter] = useState<Filter>("all");
  const [session, setSession] = useState<Moment[] | null>(null);
  const [index, setIndex] = useState(0);
  const summary = summarizeAttempts(history);

  if (session) {
    const moment = session[index];
    if (!moment) {
      return (
        <Card withBorder p="xl">
          <Stack align="center">
            <Title order={3}>{t("Training.Candidates.Done")}</Title>
            <Button onClick={() => setSession(null)}>{t("Training.Back")}</Button>
          </Stack>
        </Card>
      );
    }
    return (
      <MomentExercise
        key={moment.id}
        moment={moment}
        left={session.length - index}
        onNext={() => setIndex((i) => i + 1)}
        onStop={() => setSession(null)}
      />
    );
  }

  if (moments === null) return <Loader />;

  if (moments.length === 0) {
    return (
      <Card withBorder p="xl">
        <Stack align="center" gap="sm">
          <Text ta="center" maw={560}>
            {t("Training.Candidates.Empty")}
          </Text>
          <Button variant="light" onClick={() => navigate({ to: "/statistics" })}>
            {t("Training.Tactics.GoToStats")}
          </Button>
        </Stack>
      </Card>
    );
  }

  const done = new Set(history.map((a) => a.id));
  const lastTry = new Map(history.map((a) => [a.id, a.at]));
  const filtered = moments.filter((m) => filter === "all" || m.kind === filter);
  const fresh = filtered.filter((m) => !done.has(m.id));
  // New moments first (most recent games first), then the ones tried longest ago.
  const queue = [
    ...fresh,
    ...filtered
      .filter((m) => done.has(m.id))
      .sort((a, b) => (lastTry.get(a.id) ?? "").localeCompare(lastTry.get(b.id) ?? "")),
  ];
  const count = (k: MomentKind) => moments.filter((m) => m.kind === k).length;
  const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

  return (
    <Stack gap="md">
      <Text c="dimmed" size="sm">
        {t("Training.Candidates.Intro")}
      </Text>
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Card withBorder p="sm">
          <Text size="xs" c="dimmed">
            {t("Training.Candidates.Moments")}
          </Text>
          <Text fw={700} size="xl">
            {moments.length}
          </Text>
          <Text size="xs" c="dimmed">
            {t("Training.Candidates.NewCount", {
              n: moments.filter((m) => !done.has(m.id)).length,
            })}
          </Text>
        </Card>
        <Card withBorder p="sm">
          <Text size="xs" c="dimmed">
            {t("Training.Candidates.DoneCount")}
          </Text>
          <Text fw={700} size="xl">
            {summary.done}
          </Text>
        </Card>
        <Card withBorder p="sm">
          <Text size="xs" c="dimmed">
            {t("Training.Candidates.FoundBestRate")}
          </Text>
          <Text fw={700} size="xl">
            {pct(summary.foundBest)}
          </Text>
        </Card>
        <Card withBorder p="sm">
          <Text size="xs" c="dimmed">
            {t("Training.Candidates.GoodChoiceRate")}
          </Text>
          <Text fw={700} size="xl">
            {pct(summary.goodChoice)}
          </Text>
        </Card>
      </SimpleGrid>
      <SegmentedControl
        w="fit-content"
        value={filter}
        onChange={(v) => setFilter(v as Filter)}
        data={[
          { value: "all", label: t("Training.Candidates.All", { n: moments.length }) },
          {
            value: "punished",
            label: `${t("Training.Candidates.Kind.punished")} (${count("punished")})`,
          },
          {
            value: "missed",
            label: `${t("Training.Candidates.Kind.missed")} (${count("missed")})`,
          },
          {
            value: "turning",
            label: `${t("Training.Candidates.Kind.turning")} (${count("turning")})`,
          },
        ]}
      />
      <Group>
        <Button
          leftSection={<IconPlayerPlay size="1rem" />}
          disabled={queue.length === 0}
          onClick={() => {
            setIndex(0);
            setSession(queue);
          }}
        >
          {t("Training.Candidates.Start")}
        </Button>
      </Group>
    </Stack>
  );
}
