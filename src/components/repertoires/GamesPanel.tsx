import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  Chip,
  Group,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  ThemeIcon,
} from "@mantine/core";
import {
  IconBook,
  IconCloudDownload,
  IconExternalLink,
  IconEyeOff,
  IconHelpHexagon,
  IconRestore,
  IconTarget,
  IconUserX,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useNavigate } from "@tanstack/react-router";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import dayjs from "dayjs";
import { useAtom, useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { compareGames, type GameOutcome, type Problem } from "@/utils/gamesVsRepertoire";
import { reviewPositionNow } from "@/utils/practiceDecks";
import { formatLine, formatNextMove } from "@/utils/repertoireCheck";
import { scheduleSync } from "@/utils/sync";
import type { CheckFile } from "./checkRunner";
import {
  downloadGames,
  downloadStateAtom,
  gamesAtom,
  gamesIgnoredAtom,
  gamesReviewedAtom,
  gamesSettingsAtom,
  linkedAccounts,
  loadGames,
  SPEEDS,
} from "./gamesStore";

const REVIEW_SYNC_DELAY = 5_000;

function ProblemRow({
  problem,
  ignored,
  reviewed,
  onOpen,
  onReview,
  onIgnore,
}: {
  problem: Problem;
  ignored: boolean;
  reviewed: string | undefined;
  onOpen: () => void;
  onReview: () => void;
  onIgnore: () => void;
}) {
  const { t } = useTranslation();
  const deviation = problem.kind === "deviation";
  const latest = [...problem.games].sort((a, b) => b.date - a.date)[0];
  const where = formatLine(problem.startFen, problem.line) || t("Repertoires.Check.StartPosition");
  const played = formatNextMove(problem.startFen, problem.line, problem.played);
  return (
    <Group
      wrap="nowrap"
      justify="space-between"
      align="flex-start"
      p="xs"
      style={{
        borderRadius: "var(--mantine-radius-sm)",
        background: "var(--mantine-color-default-hover)",
        opacity: ignored ? 0.5 : 1,
      }}
    >
      <Group wrap="nowrap" align="flex-start" gap="sm" style={{ minWidth: 0 }}>
        <ThemeIcon variant="light" color={deviation ? "red" : "blue"} size="md">
          {deviation ? <IconUserX size="1rem" /> : <IconHelpHexagon size="1rem" />}
        </ThemeIcon>
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Text size="xs" c="dimmed">
            {deviation ? t("Repertoires.Games.Deviation") : t("Repertoires.Games.Hole")} ·{" "}
            {problem.label} · {where}
          </Text>
          <Text size="sm">
            {deviation
              ? t("Repertoires.Games.DeviationText", {
                  played,
                  prepared: problem.prepared.join(", "),
                })
              : t("Repertoires.Games.HoleText", {
                  played,
                  prepared: problem.prepared.join(", "),
                })}
          </Text>
          <Text size="xs" c="dimmed">
            {t("Repertoires.Games.Times", { count: problem.games.length })} ·{" "}
            {t("Repertoires.Games.Last", { when: dayjs(latest.date).format("DD/MM/YYYY") })}
            {reviewed &&
              ` · ${t("Repertoires.Games.Reviewed", { when: dayjs(reviewed).format("DD/MM/YYYY") })}`}
          </Text>
        </Stack>
      </Group>
      <Group gap={4} wrap="nowrap">
        {deviation && (
          <Button
            size="xs"
            variant={reviewed ? "subtle" : "light"}
            color="orange"
            leftSection={<IconTarget size="0.9rem" />}
            onClick={onReview}
          >
            {t("Repertoires.Games.Review")}
          </Button>
        )}
        <Button size="xs" variant="light" leftSection={<IconBook size="0.9rem" />} onClick={onOpen}>
          {t("Repertoires.Check.Open")}
        </Button>
        <Button
          size="xs"
          variant="subtle"
          color="gray"
          leftSection={<IconExternalLink size="0.9rem" />}
          onClick={() => openUrl(latest.url)}
        >
          {t("Repertoires.Games.Game")}
        </Button>
        <Button
          size="xs"
          variant="subtle"
          color="gray"
          leftSection={ignored ? <IconRestore size="0.9rem" /> : <IconEyeOff size="0.9rem" />}
          onClick={onIgnore}
        >
          {ignored ? t("Repertoires.Check.Unignore") : t("Repertoires.Check.Ignore")}
        </Button>
      </Group>
    </Group>
  );
}

function outcomeText(o: GameOutcome, t: (k: string, o?: Record<string, unknown>) => string) {
  const move = Math.floor(o.bookPlies / 2) + 1;
  switch (o.status) {
    case "deviation":
      return { color: "red", text: t("Repertoires.Games.Status.Deviation", { move }) };
    case "hole":
      return { color: "blue", text: t("Repertoires.Games.Status.Hole", { move }) };
    case "end":
      return {
        color: "teal",
        text: t("Repertoires.Games.Status.End", { move: Math.ceil(o.bookPlies / 2) }),
      };
    default:
      return { color: "gray", text: t("Repertoires.Games.Status.None") };
  }
}

export function GamesPanel({
  files,
  onOpen,
}: {
  files: CheckFile[];
  onOpen: (path: string, game: number, line: string[]) => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [settings, setSettings] = useAtom(gamesSettingsAtom);
  const [ignored, setIgnored] = useAtom(gamesIgnoredAtom);
  const [reviewed, setReviewed] = useAtom(gamesReviewedAtom);
  const download = useAtomValue(downloadStateAtom);
  const data = useAtomValue(gamesAtom);
  const [showIgnored, setShowIgnored] = useState(false);
  const accounts = useMemo(() => linkedAccounts(), []);

  useEffect(() => {
    loadGames();
  }, []);

  // Accounts chosen but no longer linked are dropped.
  const chosen = settings.accounts.filter((a) => accounts.some((x) => x.key === a));

  const { data: texts } = useSWR(
    ["repertoire-texts", files.map((f) => f.path).join("|")],
    async () =>
      Promise.all(
        files.map(async (f) => ({ ...f, text: await readTextFile(f.path).catch(() => "") })),
      ),
  );

  const games = useMemo(
    () =>
      (data?.games ?? []).filter(
        (g) => chosen.includes(`${g.source}:${g.account}`) && settings.speeds.includes(g.speed),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, settings.speeds, chosen.join("|")],
  );
  const result = useMemo(() => (texts ? compareGames(texts, games) : null), [texts, games]);

  const problems = (result?.problems ?? []).filter((p) => showIgnored || !ignored.includes(p.key));
  const ignoredCount = (result?.problems ?? []).filter((p) => ignored.includes(p.key)).length;

  const lastDate = data?.games.length ? Math.max(...data.games.map((g) => g.date)) : null;

  return (
    <Stack>
      <Card withBorder>
        {accounts.length === 0 ? (
          <Group justify="space-between">
            <Text size="sm">{t("Repertoires.Games.NoAccounts")}</Text>
            <Button variant="light" onClick={() => navigate({ to: "/accounts" })}>
              {t("Repertoires.Games.GoToAccounts")}
            </Button>
          </Group>
        ) : (
          <Stack gap="sm">
            <Group justify="space-between" align="flex-start">
              <Stack gap={6}>
                <Text size="sm" fw={500}>
                  {t("Repertoires.Games.Accounts")}
                </Text>
                <Chip.Group
                  multiple
                  value={chosen}
                  onChange={(accounts) => setSettings({ ...settings, accounts })}
                >
                  <Group gap={6}>
                    {accounts.map((a) => (
                      <Chip key={a.key} value={a.key} size="sm">
                        {a.label}
                      </Chip>
                    ))}
                  </Group>
                </Chip.Group>
                <Text size="sm" fw={500} mt={4}>
                  {t("Repertoires.Games.Speeds")}
                </Text>
                <Chip.Group
                  multiple
                  value={settings.speeds}
                  onChange={(speeds) => speeds.length && setSettings({ ...settings, speeds })}
                >
                  <Group gap={6}>
                    {SPEEDS.map((s) => (
                      <Chip key={s} value={s} size="xs">
                        {t(`Repertoires.Games.Speed.${s}`)}
                      </Chip>
                    ))}
                  </Group>
                </Chip.Group>
              </Stack>
              <Stack gap={6} align="flex-end">
                <Button
                  leftSection={<IconCloudDownload size="1rem" />}
                  loading={download.running}
                  disabled={chosen.length === 0}
                  onClick={() => downloadGames({ ...settings, accounts: chosen })}
                >
                  {t("Repertoires.Games.Download")}
                </Button>
                <Select
                  size="xs"
                  w={220}
                  label={t("Repertoires.Games.FirstDownload")}
                  value={String(settings.months)}
                  onChange={(v) => v && setSettings({ ...settings, months: Number(v) })}
                  data={[1, 3, 6, 12, 0].map((m) => ({
                    value: String(m),
                    label: m
                      ? t("Repertoires.Games.Months", { count: m })
                      : t("Repertoires.Games.AllGames"),
                  }))}
                />
                <Text size="xs" c="dimmed">
                  {download.running
                    ? download.message
                    : download.added !== null
                      ? t("Repertoires.Games.Added", { count: download.added })
                      : lastDate
                        ? t("Repertoires.Games.Stored", {
                            count: data?.games.length ?? 0,
                            when: dayjs(lastDate).format("DD/MM/YYYY"),
                          })
                        : ""}
                </Text>
              </Stack>
            </Group>
            {download.error && <Alert color="red">{download.error}</Alert>}
          </Stack>
        )}
      </Card>

      {games.length === 0 ? (
        <Center h={140}>
          <Text c="dimmed" ta="center" maw={460}>
            {t("Repertoires.Games.Empty")}
          </Text>
        </Center>
      ) : (
        <>
          <Card withBorder>
            <Group justify="space-between" mb="xs">
              <Text fw={600}>
                {t("Repertoires.Games.ToFix")} ({problems.length})
              </Text>
              {ignoredCount > 0 && (
                <Switch
                  label={t("Repertoires.Check.ShowIgnored", { count: ignoredCount })}
                  checked={showIgnored}
                  onChange={(e) => setShowIgnored(e.currentTarget.checked)}
                />
              )}
            </Group>
            {problems.length === 0 && (
              <Text size="sm" c="dimmed">
                {t("Repertoires.Games.NothingToFix")}
              </Text>
            )}
            <Stack gap={6}>
              {problems.map((p) => (
                <ProblemRow
                  key={p.key}
                  problem={p}
                  ignored={ignored.includes(p.key)}
                  reviewed={reviewed[p.key]}
                  onOpen={() => onOpen(p.path, p.game, p.line)}
                  onReview={() => {
                    if (!reviewPositionNow(p.path, p.game, p.fen))
                      notifications.show({ message: t("Repertoires.Games.NotInDeck") });
                    setReviewed({ ...reviewed, [p.key]: new Date().toISOString() });
                    scheduleSync(REVIEW_SYNC_DELAY, p.path);
                  }}
                  onIgnore={() =>
                    setIgnored((prev) =>
                      prev.includes(p.key) ? prev.filter((k) => k !== p.key) : [...prev, p.key],
                    )
                  }
                />
              ))}
            </Stack>
          </Card>

          <Card withBorder>
            <Text fw={600} mb="xs">
              {t("Repertoires.Games.BySection")}
            </Text>
            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("Repertoires.Games.Section")}</Table.Th>
                  <Table.Th ta="right">{t("Repertoires.Games.GamesCount")}</Table.Th>
                  <Table.Th ta="right">{t("Repertoires.Games.Score")}</Table.Th>
                  <Table.Th ta="right">{t("Repertoires.Games.Depth")}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(result?.sections ?? []).map((s) => (
                  <Table.Tr key={s.path}>
                    <Table.Td>{s.label}</Table.Td>
                    <Table.Td ta="right">{s.games}</Table.Td>
                    <Table.Td ta="right">{Math.round((s.points / s.games) * 100)}%</Table.Td>
                    <Table.Td ta="right">
                      {s.averageDepth.toLocaleString(i18n.language, { maximumFractionDigits: 1 })}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Card>

          <Card withBorder>
            <Text fw={600} mb="xs">
              {t("Repertoires.Games.Recent")}
            </Text>
            <Stack gap={4}>
              {(result?.outcomes ?? []).slice(0, 40).map((o) => {
                const status = outcomeText(o, t);
                return (
                  <Group key={o.game.id} justify="space-between" wrap="nowrap">
                    <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                      <Text size="sm" c="dimmed" w={80}>
                        {dayjs(o.game.date).format("DD/MM/YY")}
                      </Text>
                      <Badge
                        size="sm"
                        variant="light"
                        color={
                          o.game.result === "win"
                            ? "teal"
                            : o.game.result === "loss"
                              ? "red"
                              : "gray"
                        }
                      >
                        {t(`Repertoires.Games.Result.${o.game.result}`)}
                      </Badge>
                      <Text size="sm" truncate>
                        {o.game.myColor === "white" ? "♔" : "♚"} {o.game.opponent}
                        {o.label ? ` · ${o.label}` : ""}
                      </Text>
                    </Group>
                    <Group gap="xs" wrap="nowrap">
                      <Badge size="sm" variant="light" color={status.color}>
                        {status.text}
                      </Badge>
                      <Anchor size="xs" onClick={() => openUrl(o.game.url)}>
                        {o.game.source === "chesscom" ? "Chess.com" : "Lichess"}
                      </Anchor>
                    </Group>
                  </Group>
                );
              })}
            </Stack>
          </Card>
        </>
      )}
    </Stack>
  );
}
