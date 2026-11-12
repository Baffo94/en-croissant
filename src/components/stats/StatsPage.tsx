import { LineChart } from "@mantine/charts";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Center,
  Group,
  Progress,
  ScrollArea,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconChartBar,
  IconChevronDown,
  IconChess,
  IconChevronRight,
  IconCloudDownload,
  IconInfoCircle,
  IconMoodSmile,
  IconRepeat,
  IconSwords,
  IconTarget,
  IconTrendingUp,
} from "@tabler/icons-react";
import dayjs from "dayjs";
import { notifications } from "@mantine/notifications";
import { getDefaultStore, useAtom, useAtomValue } from "jotai";
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ENDINGS,
  type GameResult,
  type Insight,
  MIN_GAMES,
  OPPONENT_BUCKETS,
  type OpeningRow,
  performance,
  type PeriodStats,
  SESSION_BUCKETS,
  type Score,
  statsReport,
  UNKNOWN_OPENING,
} from "@/utils/accountStats";
import { linkedAccounts } from "../repertoires/gamesStore";
import { loadStatsEvals, statsEvalsAtom } from "./analysisRunner";
import {
  AnalysisCard,
  Endgames,
  EngineErrors,
  EvalBadge,
  NeedsAnalysis,
  pawns,
} from "./StatsEngine";
import {
  downloadStatsGames,
  loadStatsGames,
  needsOlderGames,
  PERIODS,
  STATS_SPEEDS,
  statsDownloadAtom,
  statsGamesAtom,
  statsSettingsAtom,
} from "./statsStore";

const SESSION_KEYS = {
  "1": "first",
  "2": "second",
  "3": "third",
  "4-5": "fourthFifth",
  "6+": "sixthOn",
} as const;

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Signed points per 100 games, e.g. "+6" or "−12". */
function signed(x: number) {
  const v = Math.round(x * 100);
  return v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0";
}

function diffColor(x: number) {
  if (x >= 0.05) return "green";
  if (x <= -0.05) return "red";
  return "gray";
}

function ResultBar({ s }: { s: Score }) {
  if (!s.n) return null;
  return (
    <Tooltip label={`${s.wins} / ${s.draws} / ${s.losses}`}>
      <Progress.Root size="md" w={110}>
        <Progress.Section value={(s.wins / s.n) * 100} color="green" />
        <Progress.Section value={(s.draws / s.n) * 100} color="gray" />
        <Progress.Section value={(s.losses / s.n) * 100} color="red" />
      </Progress.Root>
    </Tooltip>
  );
}

function Diff({ s, min = MIN_GAMES }: { s: Score | undefined; min?: number }) {
  if (!s || !s.n) return <Text c="dimmed">—</Text>;
  const d = performance(s);
  return (
    <Badge variant="light" color={s.n < min ? "gray" : diffColor(d)}>
      {signed(d)}
    </Badge>
  );
}

type Row = {
  key: string;
  label: string;
  cur: Score;
  prev?: Score;
  indent?: boolean;
  /** Content of the optional extra column. */
  extra?: ReactNode;
};

function ScoreTable({
  rows,
  firstColumn,
  expandable,
  extraColumn,
}: {
  rows: Row[];
  firstColumn: string;
  expandable?: Record<string, Row[]>;
  extraColumn?: { title: string; help: string };
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const line = (r: Row, toggle?: () => void, isOpen?: boolean) => (
    <Table.Tr key={r.key} style={{ opacity: r.cur.n < MIN_GAMES ? 0.65 : 1 }}>
      <Table.Td>
        <Group gap={4} wrap="nowrap" pl={r.indent ? 28 : 0}>
          {toggle && (
            <ActionIcon size="sm" variant="subtle" color="gray" onClick={toggle}>
              {isOpen ? <IconChevronDown size="0.9rem" /> : <IconChevronRight size="0.9rem" />}
            </ActionIcon>
          )}
          <Text size="sm" c={r.indent ? "dimmed" : undefined}>
            {r.label}
          </Text>
        </Group>
      </Table.Td>
      <Table.Td>{r.cur.n}</Table.Td>
      <Table.Td>
        <ResultBar s={r.cur} />
      </Table.Td>
      <Table.Td>{r.cur.n ? pct(r.cur.score) : "—"}</Table.Td>
      <Table.Td>{r.cur.n && r.cur.expected !== null ? pct(r.cur.expected) : "—"}</Table.Td>
      <Table.Td>
        <Diff s={r.cur} />
      </Table.Td>
      {extraColumn && <Table.Td>{r.extra ?? <Text c="dimmed">—</Text>}</Table.Td>}
      <Table.Td>
        {r.prev?.n ? (
          <Group gap={6} wrap="nowrap">
            <Diff s={r.prev} />
            <Text size="xs" c="dimmed">
              {t("Statistics.GamesShort", { count: r.prev.n })}
            </Text>
          </Group>
        ) : (
          <Text c="dimmed">—</Text>
        )}
      </Table.Td>
    </Table.Tr>
  );
  return (
    <Table.ScrollContainer minWidth={640}>
      <Table verticalSpacing={6} highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{firstColumn}</Table.Th>
            <Table.Th>{t("Statistics.Col.Games")}</Table.Th>
            <Table.Th>{t("Statistics.Col.Results")}</Table.Th>
            <Table.Th>{t("Statistics.Col.Score")}</Table.Th>
            <Table.Th>{t("Statistics.Col.Expected")}</Table.Th>
            <Table.Th>
              <Tooltip label={t("Statistics.DiffHelp")} multiline w={280}>
                <Group gap={4} wrap="nowrap">
                  {t("Statistics.Col.Diff")}
                  <IconInfoCircle size="0.9rem" />
                </Group>
              </Tooltip>
            </Table.Th>
            {extraColumn && (
              <Table.Th>
                <Tooltip label={extraColumn.help} multiline w={280}>
                  <Group gap={4} wrap="nowrap">
                    {extraColumn.title}
                    <IconInfoCircle size="0.9rem" />
                  </Group>
                </Tooltip>
              </Table.Th>
            )}
            <Table.Th>{t("Statistics.Col.Previous")}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r) => {
            const children = expandable?.[r.key];
            if (!children || children.length < 2) return line(r);
            const isOpen = !!open[r.key];
            return (
              <Fragment key={r.key}>
                {line(r, () => setOpen((o) => ({ ...o, [r.key]: !isOpen })), isOpen)}
                {isOpen && children.map((c) => line(c))}
              </Fragment>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function InsightIcon({ tone }: { tone: Insight["tone"] }) {
  if (tone === "good")
    return (
      <ThemeIcon variant="light" color="green" size="md">
        <IconMoodSmile size="1rem" />
      </ThemeIcon>
    );
  if (tone === "bad")
    return (
      <ThemeIcon variant="light" color="red" size="md">
        <IconAlertTriangle size="1rem" />
      </ThemeIcon>
    );
  return (
    <ThemeIcon variant="light" color="blue" size="md">
      <IconInfoCircle size="1rem" />
    </ThemeIcon>
  );
}

function Insights({ insights }: { insights: Insight[] }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const shown = all ? insights : insights.slice(0, 6);
  return (
    <Card withBorder p="md">
      <Text fw={600} mb="sm">
        {t("Statistics.Insights")}
      </Text>
      {insights.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t("Statistics.NoInsights", { n: MIN_GAMES })}
        </Text>
      ) : (
        <Stack gap="xs">
          {shown.map((i) => (
            <Group
              key={`${i.key}-${i.params.opening ?? ""}-${i.params.color ?? ""}`}
              wrap="nowrap"
              align="flex-start"
              gap="sm"
            >
              <InsightIcon tone={i.tone} />
              <Text size="sm" pt={3}>
                {t(`Statistics.Insight.${i.key}`, {
                  ...i.params,
                  color:
                    typeof i.params.color === "string"
                      ? t(`Statistics.Color.${i.params.color}`)
                      : "",
                  late: typeof i.params.late === "number" ? signed(i.params.late / 100) : "",
                  early: typeof i.params.early === "number" ? signed(i.params.early / 100) : "",
                  phase:
                    typeof i.params.phase === "string"
                      ? t(`Statistics.PhaseIn.${i.params.phase}`)
                      : "",
                  eval: typeof i.params.eval === "number" ? pawns(i.params.eval) : "",
                })}
              </Text>
            </Group>
          ))}
          {insights.length > 6 && (
            <Button variant="subtle" size="xs" w="fit-content" onClick={() => setAll((a) => !a)}>
              {all ? t("Statistics.ShowLess") : t("Statistics.ShowAll", { n: insights.length })}
            </Button>
          )}
        </Stack>
      )}
    </Card>
  );
}

function StatCard({
  label,
  value,
  detail,
  delta,
}: {
  label: string;
  value: string;
  detail?: string;
  delta?: { text: string; color: string };
}) {
  return (
    <Card withBorder p="sm">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Group gap="xs" align="baseline">
        <Text fw={700} size="xl">
          {value}
        </Text>
        {delta && (
          <Text size="sm" c={delta.color} fw={500}>
            {delta.text}
          </Text>
        )}
      </Group>
      {detail && (
        <Text size="xs" c="dimmed">
          {detail}
        </Text>
      )}
    </Card>
  );
}

function Summary({ cur, prev }: { cur: PeriodStats; prev: PeriodStats }) {
  const { t } = useTranslation();
  const ratingChange =
    cur.ratingFrom !== null && cur.ratingTo !== null ? cur.ratingTo - cur.ratingFrom : null;
  const prevChange =
    prev.ratingFrom !== null && prev.ratingTo !== null ? prev.ratingTo - prev.ratingFrom : null;
  const scoreDelta = prev.total.n ? cur.total.score - prev.total.score : null;
  const ratingSigned = (x: number) => (x > 0 ? `+${x}` : x < 0 ? `−${-x}` : "0");
  return (
    <SimpleGrid cols={{ base: 2, md: 5 }}>
      <StatCard
        label={t("Statistics.Card.Games")}
        value={String(cur.total.n)}
        detail={`${t("Statistics.WDL", { w: cur.total.wins, d: cur.total.draws, l: cur.total.losses })} · ${t("Statistics.PreviousValue", { value: prev.total.n })}`}
      />
      <StatCard
        label={t("Statistics.Card.Score")}
        value={pct(cur.total.score)}
        delta={
          scoreDelta !== null
            ? { text: signed(scoreDelta), color: diffColor(scoreDelta) }
            : undefined
        }
        detail={`${t("Statistics.ExpectedValue", { value: cur.total.expected !== null ? pct(cur.total.expected) : "—" })} · ${t("Statistics.PreviousValue", { value: prev.total.n ? pct(prev.total.score) : "—" })}`}
      />
      <StatCard
        label={t("Statistics.Card.Rating")}
        value={cur.ratingTo !== null ? String(cur.ratingTo) : "—"}
        delta={
          ratingChange !== null
            ? {
                text: ratingSigned(ratingChange),
                color: ratingChange > 0 ? "green" : ratingChange < 0 ? "red" : "gray",
              }
            : undefined
        }
        detail={t("Statistics.PreviousChange", {
          value: prevChange !== null ? ratingSigned(prevChange) : "—",
        })}
      />
      <StatCard
        label={t("Statistics.Card.Colors")}
        value={`${cur.white.n ? pct(cur.white.score) : "—"} / ${cur.black.n ? pct(cur.black.score) : "—"}`}
        detail={t("Statistics.ColorsDetail", { white: cur.white.n, black: cur.black.n })}
      />
      <StatCard
        label={t("Statistics.Card.Opponents")}
        value={cur.avgOpponent !== null ? String(cur.avgOpponent) : "—"}
        detail={t("Statistics.PreviousValue", {
          value: prev.avgOpponent !== null ? String(prev.avgOpponent) : "—",
        })}
      />
    </SimpleGrid>
  );
}

function RatingChart({ cur }: { cur: PeriodStats }) {
  const { t } = useTranslation();
  const data = useMemo(
    () => cur.ratings.map((p) => ({ date: dayjs(p.date).format("DD/MM"), rating: p.rating })),
    [cur.ratings],
  );
  if (data.length < 2) return null;
  return (
    <Card withBorder p="md">
      <Text fw={600} mb="sm">
        {t("Statistics.RatingTrend")}
      </Text>
      <LineChart
        h={180}
        data={data}
        dataKey="date"
        series={[{ name: "rating", label: t("Statistics.Card.Rating"), color: "blue.6" }]}
        curveType="linear"
        withDots={false}
        yAxisProps={{ domain: ["dataMin - 20", "dataMax + 20"] }}
      />
    </Card>
  );
}

function Openings({ cur, prev }: { cur: PeriodStats; prev: PeriodStats }) {
  const { t } = useTranslation();
  const [color, setColor] = useState<"white" | "black">(
    cur.white.n || !cur.black.n ? "white" : "black",
  );
  const name = (n: string) => (n === UNKNOWN_OPENING ? t("Statistics.UnknownOpening") : n);
  const prevRows = new Map(prev.openings.map((r) => [`${r.color}|${r.family}`, r]));
  const rows = cur.openings.filter((r) => r.color === color);
  const expandable: Record<string, Row[]> = {};
  const toRow = (r: OpeningRow): Row => {
    const key = `${r.color}|${r.family}`;
    const before = prevRows.get(key);
    const prevVariations = new Map(before?.variations.map((v) => [v.name, v.score]));
    expandable[key] = r.variations.map((v) => ({
      key: `${key}|${v.name}`,
      label: v.name.includes(":") ? v.name.slice(v.name.indexOf(":") + 1).trim() : name(v.name),
      cur: v.score,
      prev: prevVariations.get(v.name),
      indent: true,
    }));
    const e15 = cur.engine?.eval15ByOpening.get(key);
    return {
      key,
      label: name(r.family),
      cur: r.score,
      prev: before?.score,
      extra: e15 ? <EvalBadge cp={e15.avg} n={e15.n} /> : undefined,
    };
  };
  const tableRows = rows.map(toRow);
  return (
    <Stack gap="sm">
      <SegmentedControl
        w="fit-content"
        value={color}
        onChange={(v) => setColor(v as "white" | "black")}
        data={[
          { value: "white", label: `${t("Statistics.Color.white")} (${cur.white.n})` },
          { value: "black", label: `${t("Statistics.Color.black")} (${cur.black.n})` },
        ]}
      />
      {tableRows.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t("Statistics.NoGames")}
        </Text>
      ) : (
        <ScoreTable
          rows={tableRows}
          firstColumn={t("Statistics.Col.Opening")}
          expandable={expandable}
          extraColumn={
            cur.engine?.analysed
              ? { title: t("Statistics.Col.Eval15"), help: t("Statistics.Eval15Help") }
              : undefined
          }
        />
      )}
    </Stack>
  );
}

function EndingsTable({ cur, prev }: { cur: PeriodStats; prev: PeriodStats }) {
  const { t } = useTranslation();
  const results: GameResult[] = ["win", "loss", "draw"];
  const totals = { win: cur.total.wins, loss: cur.total.losses, draw: cur.total.draws };
  const prevTotals = { win: prev.total.wins, loss: prev.total.losses, draw: prev.total.draws };
  return (
    <SimpleGrid cols={{ base: 1, md: 3 }}>
      {results.map((r) => {
        const endings = ENDINGS.filter(
          (e) => (cur.habits.endings[r][e] ?? 0) > 0 || (prev.habits.endings[r][e] ?? 0) > 0,
        );
        return (
          <Card key={r} withBorder p="sm">
            <Text fw={600} size="sm" mb={6}>
              {t(`Statistics.Endings.${r}`)} ({totals[r]})
            </Text>
            {endings.length === 0 ? (
              <Text size="sm" c="dimmed">
                —
              </Text>
            ) : (
              <Table verticalSpacing={4}>
                <Table.Tbody>
                  {endings.map((e) => {
                    const n = cur.habits.endings[r][e] ?? 0;
                    const p = prev.habits.endings[r][e] ?? 0;
                    return (
                      <Table.Tr key={e}>
                        <Table.Td>
                          <Text size="sm">{t(`Statistics.Ending.${e}`)}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">
                            {n} {totals[r] ? `(${pct(n / totals[r])})` : ""}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" c="dimmed">
                            {prevTotals[r]
                              ? t("Statistics.PreviousValue", { value: pct(p / prevTotals[r]) })
                              : ""}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            )}
          </Card>
        );
      })}
    </SimpleGrid>
  );
}

function Habits({ cur, prev }: { cur: PeriodStats; prev: PeriodStats }) {
  const { t } = useTranslation();
  const after = (["first", "win", "draw", "loss", "lossStreak"] as const).map((k) => ({
    key: k,
    label: t(`Statistics.After.${k}`),
    cur: cur.habits.after[k],
    prev: prev.habits.after[k],
  }));
  const session = SESSION_BUCKETS.map((b) => ({
    key: b,
    label: t(`Statistics.Session.${SESSION_KEYS[b]}`),
    cur: cur.habits.session[b],
    prev: prev.habits.session[b],
  }));
  const opponents = OPPONENT_BUCKETS.map((b) => ({
    key: b,
    label: t(`Statistics.Opponents.${b}`),
    cur: cur.habits.opponents[b],
    prev: prev.habits.opponents[b],
  }));
  return (
    <Stack gap="md">
      <Card withBorder p="md">
        <Text fw={600}>{t("Statistics.AfterTitle")}</Text>
        <Text size="xs" c="dimmed" mb="xs">
          {t("Statistics.SessionHelp")}
        </Text>
        <ScoreTable rows={after} firstColumn={t("Statistics.Col.Situation")} />
      </Card>
      <Card withBorder p="md">
        <Text fw={600} mb="xs">
          {t("Statistics.SessionTitle")}
        </Text>
        <ScoreTable rows={session} firstColumn={t("Statistics.Col.Situation")} />
      </Card>
      <Card withBorder p="md">
        <Text fw={600} mb="xs">
          {t("Statistics.OpponentsTitle")}
        </Text>
        <ScoreTable rows={opponents} firstColumn={t("Statistics.Col.Opponent")} />
      </Card>
      <div>
        <Text fw={600} mb="xs">
          {t("Statistics.EndingsTitle")}
        </Text>
        <EndingsTable cur={cur} prev={prev} />
      </div>
    </Stack>
  );
}

export default function StatsPage() {
  const { t } = useTranslation();
  const [settings, setSettings] = useAtom(statsSettingsAtom);
  const data = useAtomValue(statsGamesAtom);
  const download = useAtomValue(statsDownloadAtom);
  const evals = useAtomValue(statsEvalsAtom);
  const [tab, setTab] = useState<string | null>("openings");
  const accounts = useMemo(() => linkedAccounts(), []);

  useEffect(() => {
    loadStatsGames();
    loadStatsEvals();
  }, []);

  // Default account: the first Chess.com one (that is where the serious games are).
  const account =
    settings.account && accounts.some((a) => a.key === settings.account)
      ? settings.account
      : ((accounts.find((a) => a.key.startsWith("chesscom:")) ?? accounts[0])?.key ?? null);

  const entry = account ? data?.accounts[account] : undefined;
  const report = useMemo(
    () =>
      entry
        ? statsReport(
            entry.games,
            { speed: settings.speed, ratedOnly: settings.ratedOnly, days: settings.days },
            entry.to,
            evals ?? undefined,
          )
        : null,
    [entry, settings.speed, settings.ratedOnly, settings.days, evals],
  );
  const speedsWithGames = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const g of entry?.games ?? []) counts[g.speed] = (counts[g.speed] ?? 0) + 1;
    return counts;
  }, [entry]);

  const startDownload = async () => {
    if (!account) return;
    await downloadStatsGames(account, settings.days);
    const state = getDefaultStore().get(statsDownloadAtom);
    if (state.added !== null)
      notifications.show({
        color: "green",
        message: state.added
          ? t("Statistics.Added", { count: state.added })
          : t("Statistics.NoneAdded"),
      });
  };

  const incomplete = entry && needsOlderGames(entry, settings.days, entry.to);

  return (
    <Stack h="100%" gap={0}>
      <Group px="lg" pt="lg" pb="sm" justify="space-between" align="flex-end">
        <div>
          <Title order={2}>{t("Statistics.Title")}</Title>
          <Text c="dimmed" size="sm">
            {entry
              ? t("Statistics.Updated", {
                  when: dayjs(entry.to).format("DD/MM/YYYY HH:mm"),
                  count: entry.games.length,
                })
              : t("Statistics.Subtitle")}
          </Text>
        </div>
        {account && (
          <Group gap="xs">
            {download.running && (
              <Text size="sm" c="dimmed">
                {download.message}
              </Text>
            )}
            <Button
              leftSection={<IconCloudDownload size="1rem" />}
              loading={download.running}
              onClick={startDownload}
            >
              {entry ? t("Statistics.Update") : t("Statistics.Download")}
            </Button>
          </Group>
        )}
      </Group>

      {accounts.length === 0 ? (
        <Center flex={1} p="lg">
          <Alert icon={<IconInfoCircle />} maw={520}>
            {t("Statistics.NoAccounts")}
          </Alert>
        </Center>
      ) : (
        <>
          <Group px="lg" pb="sm" gap="md" align="flex-end">
            <Select
              label={t("Statistics.Account")}
              data={accounts.map((a) => ({ value: a.key, label: a.label }))}
              value={account}
              allowDeselect={false}
              onChange={(v) => v && setSettings({ ...settings, account: v })}
              w={240}
            />
            <div>
              <Text size="sm" fw={500} mb={2}>
                {t("Statistics.Speed")}
              </Text>
              <SegmentedControl
                value={settings.speed}
                onChange={(v) => setSettings({ ...settings, speed: v })}
                data={STATS_SPEEDS.filter(
                  (s) => !entry || s === settings.speed || speedsWithGames[s],
                ).map((s) => ({
                  value: s,
                  label: `${t(`Repertoires.Games.Speed.${s}`)}${entry ? ` (${speedsWithGames[s] ?? 0})` : ""}`,
                }))}
              />
            </div>
            <Select
              label={t("Statistics.Period")}
              data={PERIODS.map((d) => ({
                value: String(d),
                label: t("Statistics.Days", { count: d }),
              }))}
              value={String(settings.days)}
              allowDeselect={false}
              onChange={(v) => v && setSettings({ ...settings, days: Number(v) })}
              w={190}
            />
            <Switch
              mb={8}
              label={t("Statistics.RatedOnly")}
              checked={settings.ratedOnly}
              onChange={(e) => setSettings({ ...settings, ratedOnly: e.currentTarget.checked })}
            />
          </Group>

          <ScrollArea flex={1} px="lg" pb="lg">
            <Stack gap="md" pb="lg">
              {download.error && (
                <Alert color="red" icon={<IconAlertTriangle />}>
                  {download.error}
                </Alert>
              )}
              {!entry ? (
                <Card withBorder p="xl">
                  <Stack align="center" gap="sm">
                    <ThemeIcon size="xl" variant="light">
                      <IconChartBar />
                    </ThemeIcon>
                    <Text ta="center" maw={520}>
                      {t("Statistics.FirstDownload", { days: settings.days * 2 })}
                    </Text>
                    <Button
                      leftSection={<IconCloudDownload size="1rem" />}
                      loading={download.running}
                      onClick={startDownload}
                    >
                      {t("Statistics.Download")}
                    </Button>
                  </Stack>
                </Card>
              ) : (
                report && (
                  <>
                    {incomplete && (
                      <Alert color="yellow" icon={<IconAlertTriangle />}>
                        <Group justify="space-between">
                          <Text size="sm">
                            {t("Statistics.Incomplete", {
                              from: dayjs(entry.from).format("DD/MM/YYYY"),
                            })}
                          </Text>
                          <Button
                            size="xs"
                            variant="light"
                            color="yellow"
                            loading={download.running}
                            onClick={startDownload}
                          >
                            {t("Statistics.Download")}
                          </Button>
                        </Group>
                      </Alert>
                    )}
                    <Text size="sm" c="dimmed">
                      {t("Statistics.PeriodText", {
                        from: dayjs(entry.to - settings.days * 24 * 3600 * 1000).format(
                          "DD/MM/YYYY",
                        ),
                        to: dayjs(entry.to).format("DD/MM/YYYY"),
                      })}
                    </Text>
                    {report.current.total.n === 0 ? (
                      <Card withBorder p="lg">
                        <Text c="dimmed" ta="center">
                          {t("Statistics.NoGames")}
                        </Text>
                      </Card>
                    ) : (
                      <>
                        <AnalysisCard
                          games={[...report.current.games, ...report.previous.games].sort(
                            (a, b) => b.end - a.end,
                          )}
                        />
                        <Insights insights={report.insights} />
                        <Summary cur={report.current} prev={report.previous} />
                        <RatingChart cur={report.current} />
                        <Tabs value={tab} onChange={setTab}>
                          <Tabs.List>
                            <Tabs.Tab value="openings" leftSection={<IconSwords size="1rem" />}>
                              {t("Statistics.Tab.Openings")}
                            </Tabs.Tab>
                            <Tabs.Tab value="errors" leftSection={<IconTarget size="1rem" />}>
                              {t("Statistics.Tab.Errors")}
                            </Tabs.Tab>
                            <Tabs.Tab value="endgames" leftSection={<IconChess size="1rem" />}>
                              {t("Statistics.Tab.Endgames")}
                            </Tabs.Tab>
                            <Tabs.Tab value="habits" leftSection={<IconRepeat size="1rem" />}>
                              {t("Statistics.Tab.Habits")}
                            </Tabs.Tab>
                          </Tabs.List>
                          <Tabs.Panel value="openings" pt="md">
                            <Openings cur={report.current} prev={report.previous} />
                          </Tabs.Panel>
                          <Tabs.Panel value="errors" pt="md">
                            {report.current.engine?.analysed ? (
                              <EngineErrors
                                cur={report.current.engine}
                                prev={report.previous.engine}
                              />
                            ) : (
                              <NeedsAnalysis />
                            )}
                          </Tabs.Panel>
                          <Tabs.Panel value="endgames" pt="md">
                            {report.current.engine?.analysed ? (
                              <Endgames cur={report.current.engine} prev={report.previous.engine} />
                            ) : (
                              <NeedsAnalysis />
                            )}
                          </Tabs.Panel>
                          <Tabs.Panel value="habits" pt="md">
                            <Habits cur={report.current} prev={report.previous} />
                          </Tabs.Panel>
                        </Tabs>
                        <Group gap={6}>
                          <IconTrendingUp size="0.9rem" color="var(--mantine-color-dimmed)" />
                          <Text size="xs" c="dimmed">
                            {t("Statistics.DiffHelp")}
                          </Text>
                        </Group>
                      </>
                    )}
                  </>
                )
              )}
            </Stack>
          </ScrollArea>
        </>
      )}
    </Stack>
  );
}
