// Statistics page, phase 2: the engine analysis of the games and what comes out of it.

import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Progress,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { IconAlertTriangle, IconCpu, IconPlayerStop } from "@tabler/icons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import dayjs from "dayjs";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { StatsGame } from "@/utils/accountStats";
import {
  type EngineStats,
  type Outcomes,
  PHASES,
  type PhaseCount,
  seriousRate,
} from "@/utils/gameReview";
import {
  MS_PER_MOVE,
  remainingMs,
  startStatsAnalysis,
  statsAnalysisRunAtom,
  statsEvalsAtom,
  stopStatsAnalysis,
} from "./analysisRunner";

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Centipawns as pawns with a sign: "+0.8", "−1.2". */
export function pawns(cp: number) {
  const v = Math.round(cp / 10) / 10;
  if (v === 0) return "0.0";
  return v > 0 ? `+${v.toFixed(1)}` : `−${(-v).toFixed(1)}`;
}

export function EvalBadge({ cp, n }: { cp: number; n: number }) {
  const { t } = useTranslation();
  const color = cp >= 50 ? "green" : cp <= -50 ? "red" : "gray";
  return (
    <Tooltip label={t("Statistics.AnalysedGames", { count: n })}>
      <Badge variant="light" color={n < 8 ? "gray" : color}>
        {pawns(cp)}
      </Badge>
    </Tooltip>
  );
}

export function NeedsAnalysis() {
  const { t } = useTranslation();
  return (
    <Text size="sm" c="dimmed">
      {t("Statistics.NeedsAnalysis")}
    </Text>
  );
}

function duration(ms: number, t: (k: string, o?: Record<string, unknown>) => string) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return t("Statistics.Minutes", { count: minutes });
  const h = Math.floor(minutes / 60);
  return t("Statistics.HoursMinutes", { h, m: minutes % 60 });
}

/** State of the engine analysis for the games on screen, with start and stop. */
export function AnalysisCard({ games }: { games: StatsGame[] }) {
  const { t } = useTranslation();
  const evals = useAtomValue(statsEvalsAtom);
  const run = useAtomValue(statsAnalysisRunAtom);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!run.running) return;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [run.running]);
  const analysed = games.filter((g) => evals?.[g.id]).length;
  const missing = games.filter((g) => !evals?.[g.id]);
  const plies = missing.reduce((s, g) => s + (g.moves ? g.moves.split(" ").length : 0), 0);
  return (
    <Card withBorder p="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Group gap={6}>
            <IconCpu size="1.1rem" />
            <Text fw={600}>{t("Statistics.Analysis.Title")}</Text>
          </Group>
          <Text size="sm" mt={4}>
            {t("Statistics.Analysis.Count", { done: analysed, total: games.length })}
          </Text>
          {!run.running && missing.length > 0 && (
            <Text size="xs" c="dimmed">
              {t("Statistics.Analysis.Estimate", {
                time: duration(plies * MS_PER_MOVE, t),
              })}
            </Text>
          )}
        </div>
        {run.running ? (
          <Button
            color="red"
            variant="light"
            leftSection={<IconPlayerStop size="1rem" />}
            onClick={stopStatsAnalysis}
          >
            {t("Statistics.Analysis.Stop")}
          </Button>
        ) : (
          missing.length > 0 && (
            <Button
              leftSection={<IconCpu size="1rem" />}
              onClick={() => startStatsAnalysis(missing)}
            >
              {analysed > 0 ? t("Statistics.Analysis.Resume") : t("Statistics.Analysis.Start")}
            </Button>
          )
        )}
      </Group>
      {run.running && (
        <Stack gap={4} mt="sm">
          <Progress value={run.pliesTotal ? (run.pliesDone / run.pliesTotal) * 100 : 0} animated />
          <Text size="xs" c="dimmed">
            {t("Statistics.Analysis.Running", {
              done: run.done,
              total: run.total,
              engine: run.engine,
              time: duration(remainingMs(run, now), t),
            })}
          </Text>
        </Stack>
      )}
      {!run.running && run.error && (
        <Alert color="red" mt="sm" icon={<IconAlertTriangle />}>
          {run.error === "NoEngine" ? t("Statistics.Analysis.NoEngine") : run.error}
        </Alert>
      )}
      {run.failed > 0 && (
        <Text size="xs" c="orange" mt={4}>
          {t("Statistics.Analysis.Failed", { count: run.failed })}
        </Text>
      )}
      <Text size="xs" c="dimmed" mt={6}>
        {t("Statistics.Analysis.Help")}
      </Text>
    </Card>
  );
}

function StatCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <Card withBorder p="sm">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={700} size="xl">
        {value}
      </Text>
      {detail && (
        <Text size="xs" c="dimmed">
          {detail}
        </Text>
      )}
    </Card>
  );
}

const rate = (x: number | null) => (x === null ? "—" : (Math.round(x * 10) / 10).toFixed(1));

function perHundred(p: PhaseCount, f: (p: PhaseCount) => number) {
  return p.moves ? (f(p) / p.moves) * 100 : null;
}

function OutcomeRow({
  label,
  cur,
  prev,
  share,
}: {
  label: string;
  cur: Outcomes;
  prev: Outcomes | undefined;
  share: (o: Outcomes) => number;
}) {
  return (
    <Table.Tr>
      <Table.Td>
        <Text size="sm">{label}</Text>
      </Table.Td>
      <Table.Td>{cur.n}</Table.Td>
      <Table.Td>{cur.wins}</Table.Td>
      <Table.Td>{cur.draws}</Table.Td>
      <Table.Td>{cur.losses}</Table.Td>
      <Table.Td>
        <Text fw={600} size="sm">
          {cur.n ? pct(share(cur)) : "—"}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm" c="dimmed">
          {prev?.n ? pct(share(prev)) : "—"}
        </Text>
      </Table.Td>
    </Table.Tr>
  );
}

export function EngineErrors({ cur, prev }: { cur: EngineStats; prev: EngineStats | null }) {
  const { t } = useTranslation();
  const prevText = (v: string) => t("Statistics.PreviousValue", { value: v });
  const tt = cur.timeTrouble;
  const ptt = prev?.timeTrouble;
  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <StatCard
          label={t("Statistics.Engine.Accuracy")}
          value={cur.accuracy !== null ? `${cur.accuracy.toFixed(1)}%` : "—"}
          detail={prevText(
            prev?.accuracy != null && prev.analysed ? `${prev.accuracy.toFixed(1)}%` : "—",
          )}
        />
        <StatCard
          label={t("Statistics.Engine.SeriousPerGame")}
          value={cur.perGame ? rate(cur.perGame.mistakes + cur.perGame.blunders) : "—"}
          detail={t("Statistics.Engine.SeriousDetail", {
            mistakes: rate(cur.perGame?.mistakes ?? null),
            blunders: rate(cur.perGame?.blunders ?? null),
            previous: prev?.perGame ? rate(prev.perGame.mistakes + prev.perGame.blunders) : "—",
          })}
        />
        <StatCard
          label={t("Statistics.Engine.InaccuraciesPerGame")}
          value={rate(cur.perGame?.inaccuracies ?? null)}
          detail={prevText(rate(prev?.perGame?.inaccuracies ?? null))}
        />
        <StatCard
          label={t("Statistics.Engine.TimeTrouble")}
          value={tt.seriousWithClock ? pct(tt.seriousInTrouble / tt.seriousWithClock) : "—"}
          detail={t("Statistics.Engine.TimeTroubleDetail", {
            moves: tt.movesWithClock ? pct(tt.movesInTrouble / tt.movesWithClock) : "—",
            previous: ptt?.seriousWithClock
              ? pct(ptt.seriousInTrouble / ptt.seriousWithClock)
              : "—",
          })}
        />
      </SimpleGrid>

      <Card withBorder p="md">
        <Text fw={600}>{t("Statistics.Engine.ByPhase")}</Text>
        <Text size="xs" c="dimmed" mb="xs">
          {t("Statistics.Engine.PhaseHelp")}
        </Text>
        <Table.ScrollContainer minWidth={560}>
          <Table verticalSpacing={6}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t("Statistics.Col.Phase")}</Table.Th>
                <Table.Th>{t("Statistics.Col.Moves")}</Table.Th>
                <Table.Th>{t("Statistics.Col.Inaccuracies100")}</Table.Th>
                <Table.Th>{t("Statistics.Col.Mistakes100")}</Table.Th>
                <Table.Th>{t("Statistics.Col.Blunders100")}</Table.Th>
                <Table.Th>{t("Statistics.Col.SeriousPrevious")}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {PHASES.map((ph) => {
                const p = cur.phases[ph];
                return (
                  <Table.Tr key={ph}>
                    <Table.Td>{t(`Statistics.Phase.${ph}`)}</Table.Td>
                    <Table.Td>{p.moves}</Table.Td>
                    <Table.Td>{rate(perHundred(p, (x) => x.inaccuracies))}</Table.Td>
                    <Table.Td>{rate(perHundred(p, (x) => x.mistakes))}</Table.Td>
                    <Table.Td>{rate(perHundred(p, (x) => x.blunders))}</Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {prev ? rate(seriousRate(prev.phases[ph])) : "—"}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>

      <Card withBorder p="md">
        <Text fw={600}>{t("Statistics.Engine.Conversion")}</Text>
        <Text size="xs" c="dimmed" mb="xs">
          {t("Statistics.Engine.ConversionHelp")}
        </Text>
        <Table.ScrollContainer minWidth={560}>
          <Table verticalSpacing={6}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th />
                <Table.Th>{t("Statistics.Col.Games")}</Table.Th>
                <Table.Th>{t("Statistics.Endings.win")}</Table.Th>
                <Table.Th>{t("Statistics.Endings.draw")}</Table.Th>
                <Table.Th>{t("Statistics.Endings.loss")}</Table.Th>
                <Table.Th>%</Table.Th>
                <Table.Th>{t("Statistics.Col.Previous")}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              <OutcomeRow
                label={t("Statistics.Engine.Winning")}
                cur={cur.conversion}
                prev={prev?.conversion}
                share={(o) => o.wins / o.n}
              />
              <OutcomeRow
                label={t("Statistics.Engine.Losing")}
                cur={cur.comebacks}
                prev={prev?.comebacks}
                share={(o) => (o.wins + o.draws / 2) / o.n}
              />
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>

      <Card withBorder p="md">
        <Text fw={600}>{t("Statistics.Engine.Eval15")}</Text>
        <Text size="xs" c="dimmed" mb="xs">
          {t("Statistics.Eval15Help")}
        </Text>
        <Group gap="xl">
          {(["white", "black"] as const).map((c) => (
            <div key={c}>
              <Text size="xs" c="dimmed">
                {t(`Statistics.Color.${c}`)}
              </Text>
              <Text fw={700}>
                {cur.eval15[c].avg !== null ? pawns(cur.eval15[c].avg as number) : "—"}
              </Text>
              <Text size="xs" c="dimmed">
                {prevText(prev?.eval15[c].avg != null ? pawns(prev.eval15[c].avg as number) : "—")}
              </Text>
            </div>
          ))}
          <div>
            <Text size="xs" c="dimmed">
              {t("Statistics.Engine.Eval15Split")}
            </Text>
            <Text fw={700}>
              {cur.eval15.better} / {cur.eval15.equal} / {cur.eval15.worse}
            </Text>
          </div>
        </Group>
      </Card>

      {cur.errors.length > 0 && (
        <Card withBorder p="md">
          <Text fw={600} mb="xs">
            {t("Statistics.Engine.WorstErrors")}
          </Text>
          <Table.ScrollContainer minWidth={640}>
            <Table verticalSpacing={4} highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("Statistics.Col.Date")}</Table.Th>
                  <Table.Th>{t("Statistics.Col.Played")}</Table.Th>
                  <Table.Th>{t("Statistics.Col.Best")}</Table.Th>
                  <Table.Th>{t("Statistics.Col.EvalChange")}</Table.Th>
                  <Table.Th>{t("Statistics.Col.Phase")}</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {cur.errors.map((e) => (
                  <Table.Tr key={`${e.gameId}-${e.moveLabel}`}>
                    <Table.Td>{dayjs(e.end).format("DD/MM/YY")}</Table.Td>
                    <Table.Td>
                      <Text size="sm" fw={600} c="red">
                        {e.moveLabel} {e.played}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="green">
                        {e.best || "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {pawns(e.before)} → {pawns(e.after)}
                    </Table.Td>
                    <Table.Td>{t(`Statistics.Phase.${e.phase}`)}</Table.Td>
                    <Table.Td>
                      <Anchor size="xs" onClick={() => openUrl(e.url)}>
                        {t("Statistics.OpenGame")}
                      </Anchor>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      )}
    </Stack>
  );
}

export function Endgames({ cur, prev }: { cur: EngineStats; prev: EngineStats | null }) {
  const { t } = useTranslation();
  const eg = cur.endgames;
  const peg = prev?.endgames;
  const diff = (e: EngineStats["endgames"]) => (e.n ? (e.score - e.expected) / e.n : null);
  const signed = (x: number | null) => {
    if (x === null) return "—";
    const v = Math.round(x * 100);
    return v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0";
  };
  const d = diff(eg);
  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, md: 3 }}>
        <StatCard
          label={t("Statistics.Engine.EndgamesPlayed")}
          value={String(eg.n)}
          detail={t("Statistics.Engine.EndgamesShare", {
            share: cur.analysed ? pct(eg.n / cur.analysed) : "—",
            previous: peg?.n ?? 0,
          })}
        />
        <Card withBorder p="sm">
          <Text size="xs" c="dimmed">
            {t("Statistics.Engine.EndgameResult")}
          </Text>
          <Group gap="xs" align="baseline">
            <Text fw={700} size="xl">
              {eg.n ? pct(eg.score / eg.n) : "—"}
            </Text>
            {d !== null && (
              <Badge
                variant="light"
                color={eg.n < 10 ? "gray" : d >= 0.05 ? "green" : d <= -0.05 ? "red" : "gray"}
              >
                {signed(d)}
              </Badge>
            )}
          </Group>
          <Text size="xs" c="dimmed">
            {t("Statistics.Engine.EndgameExpected", {
              expected: eg.n ? pct(eg.expected / eg.n) : "—",
              previous: peg ? signed(diff(peg)) : "—",
            })}
          </Text>
        </Card>
        <StatCard
          label={t("Statistics.Engine.EndgameErrors")}
          value={rate(seriousRate(eg.errors))}
          detail={t("Statistics.PreviousValue", {
            value: peg ? rate(seriousRate(peg.errors)) : "—",
          })}
        />
      </SimpleGrid>
      <Text size="xs" c="dimmed">
        {t("Statistics.Engine.EndgameHelp")}
      </Text>
    </Stack>
  );
}
