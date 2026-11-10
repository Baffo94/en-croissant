import {
  Alert,
  Badge,
  Button,
  Card,
  Center,
  Group,
  Progress,
  Stack,
  Switch,
  Text,
  ThemeIcon,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowsShuffle,
  IconBook,
  IconEyeOff,
  IconHelpHexagon,
  IconPlayerStop,
  IconRestore,
  IconSearch,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import dayjs from "dayjs";
import { useAtom, useAtomValue } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { repertoireCheckSettingsAtom } from "@/state/atoms";
import {
  DEFAULT_CHECK_SETTINGS,
  formatLine,
  formatNextMove,
  type Issue,
} from "@/utils/repertoireCheck";
import { normalizePath } from "@/utils/sync/core";
import {
  type CheckFile,
  checkIgnoredAtom,
  checkResultsAtom,
  checkRunAtom,
  ignoreKey,
  startCheck,
  stopCheck,
} from "./checkRunner";

const KIND_ORDER: Issue["kind"][] = ["inconsistent", "dubious", "hole"];

function pawns(cp: number): string {
  return (cp / 100).toFixed(1).replace(".", ",");
}

function IssueRow({
  issue,
  ignored,
  onOpen,
  onIgnore,
}: {
  issue: Issue;
  ignored: boolean;
  onOpen: () => void;
  onIgnore: () => void;
}) {
  const { t, i18n } = useTranslation();
  const where = formatLine(issue.startFen, issue.line) || t("Repertoires.Check.StartPosition");
  let icon = <IconHelpHexagon size="1rem" />;
  let color = "blue";
  let title = "";
  let text = "";
  if (issue.kind === "hole") {
    title = t("Repertoires.Check.Hole");
    text = t("Repertoires.Check.HoleText", {
      move: formatNextMove(issue.startFen, issue.line, issue.move),
      share: Math.round(issue.share * 100),
      games: issue.games.toLocaleString(i18n.language),
    });
  } else if (issue.kind === "dubious") {
    icon = <IconAlertTriangle size="1rem" />;
    color = "orange";
    title = t("Repertoires.Check.Dubious");
    text = t("Repertoires.Check.DubiousText", {
      move: formatNextMove(issue.startFen, issue.line, issue.move),
      best: issue.best,
      loss: pawns(issue.loss),
    });
  } else {
    icon = <IconArrowsShuffle size="1rem" />;
    color = "grape";
    title = t("Repertoires.Check.Inconsistent");
    text = t("Repertoires.Check.InconsistentText", {
      move: issue.move,
      others: issue.others.map((o) => `${o.move} (${o.label})`).join(", "),
    });
  }
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
        <ThemeIcon variant="light" color={color} size="md">
          {icon}
        </ThemeIcon>
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Text size="xs" c="dimmed">
            {title} · {where}
          </Text>
          <Text size="sm">{text}</Text>
        </Stack>
      </Group>
      <Group gap={4} wrap="nowrap">
        <Button size="xs" variant="light" leftSection={<IconBook size="0.9rem" />} onClick={onOpen}>
          {t("Repertoires.Check.Open")}
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

/** Issues of the last check that are not ignored, per file (for badges). */
export function useOpenIssues(): (path: string) => number {
  const results = useAtomValue(checkResultsAtom);
  const ignored = useAtomValue(checkIgnoredAtom);
  return (path) => {
    const r = results[normalizePath(path)];
    if (!r) return 0;
    return r.issues.filter((i) => !ignored.includes(ignoreKey(path, i))).length;
  };
}

export function CheckPanel({
  files,
  onOpen,
}: {
  files: CheckFile[];
  onOpen: (path: string, game: number, line: string[]) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const run = useAtomValue(checkRunAtom);
  const results = useAtomValue(checkResultsAtom);
  const [ignored, setIgnored] = useAtom(checkIgnoredAtom);
  const settings = { ...DEFAULT_CHECK_SETTINGS, ...useAtomValue(repertoireCheckSettingsAtom) };
  const [showIgnored, setShowIgnored] = useState(false);

  const checked = files
    .map((f) => ({ file: f, result: results[normalizePath(f.path)] }))
    .filter((x) => x.result)
    .sort((a, b) => a.file.label.localeCompare(b.file.label));
  const ignoredCount = checked.reduce(
    (n, { file, result }) =>
      n + result.issues.filter((i) => ignored.includes(ignoreKey(file.path, i))).length,
    0,
  );

  const elapsed = Date.now() - run.startedAt;
  const left = run.done > 0 ? (elapsed / run.done) * (run.total - run.done) : null;

  return (
    <Stack>
      <Card withBorder>
        <Group justify="space-between" wrap="nowrap">
          <Stack gap={2}>
            <Text size="sm">
              {t("Repertoires.Check.Settings", {
                ratings: `${Math.min(...settings.ratings)}–${Math.max(...settings.ratings)}`,
                speeds: settings.speeds.join(", "),
                seconds: settings.engineMs / 1000,
                share: Math.round(settings.holeShare * 100),
                loss: pawns(settings.lossCp),
              })}
            </Text>
            <Text
              size="xs"
              c="blue"
              style={{ cursor: "pointer" }}
              onClick={() => navigate({ to: "/settings" })}
            >
              {t("Repertoires.Check.ChangeSettings")}
            </Text>
          </Stack>
          {run.running ? (
            <Button
              color="red"
              variant="light"
              leftSection={<IconPlayerStop size="1rem" />}
              onClick={stopCheck}
            >
              {t("Repertoires.Check.Stop")}
            </Button>
          ) : (
            <Button
              leftSection={<IconSearch size="1rem" />}
              disabled={files.length === 0}
              onClick={() =>
                startCheck(
                  files,
                  files.map((f) => f.path),
                  t("Repertoires.Check.All"),
                )
              }
            >
              {t("Repertoires.Check.RunAll")}
            </Button>
          )}
        </Group>
        {run.running && (
          <Stack gap={4} mt="md">
            <Text size="sm">
              {run.label}
              {run.current ? ` — ${run.current}` : ""}
            </Text>
            <Progress value={run.total > 0 ? (run.done / run.total) * 100 : 0} animated />
            <Text size="xs" c="dimmed">
              {run.total > 0 ? `${run.done}/${run.total}` : t("Repertoires.Check.Preparing")}
              {left !== null && run.done >= 3
                ? ` · ${t("Repertoires.Check.Left", { min: Math.max(1, Math.round(left / 60000)) })}`
                : ""}
            </Text>
          </Stack>
        )}
        {!run.running && run.error && (
          <Alert color="red" mt="md">
            {run.error === "NoEngine"
              ? t("Repertoires.Check.NoEngine")
              : run.error === "NoLichess"
                ? t("Repertoires.Check.NoLichess")
                : t("Repertoires.Check.Failed", { error: run.error })}
          </Alert>
        )}
      </Card>

      {checked.length === 0 && !run.running && (
        <Center h={160}>
          <Text c="dimmed" ta="center" maw={460}>
            {t("Repertoires.Check.Empty")}
          </Text>
        </Center>
      )}

      {ignoredCount > 0 && (
        <Switch
          label={t("Repertoires.Check.ShowIgnored", { count: ignoredCount })}
          checked={showIgnored}
          onChange={(e) => setShowIgnored(e.currentTarget.checked)}
        />
      )}

      {checked.map(({ file, result }) => {
        const issues = result.issues
          .filter((i) => showIgnored || !ignored.includes(ignoreKey(file.path, i)))
          .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
        return (
          <Card key={file.path} withBorder>
            <Group justify="space-between" mb="xs">
              <Group gap="xs">
                <Text fw={600}>{file.label}</Text>
                {issues.length > 0 ? (
                  <Badge color="orange" variant="light">
                    {t("Repertoires.Check.Issues", { count: issues.length })}
                  </Badge>
                ) : (
                  <Badge color="teal" variant="light">
                    {t("Repertoires.Check.NoIssues")}
                  </Badge>
                )}
              </Group>
              <Group gap="xs">
                <Text size="xs" c="dimmed">
                  {t("Repertoires.Check.CheckedAt", {
                    when: dayjs(result.checkedAt).format("DD/MM/YYYY HH:mm"),
                  })}
                </Text>
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={run.running}
                  onClick={() => startCheck(files, [file.path], file.label)}
                >
                  {t("Repertoires.Check.Again")}
                </Button>
              </Group>
            </Group>
            <Stack gap={6}>
              {issues.map((issue) => {
                const key = ignoreKey(file.path, issue);
                const isIgnored = ignored.includes(key);
                return (
                  <IssueRow
                    key={issue.id}
                    issue={issue}
                    ignored={isIgnored}
                    onOpen={() => onOpen(file.path, issue.game, issue.line)}
                    onIgnore={() =>
                      setIgnored((prev) =>
                        isIgnored ? prev.filter((k) => k !== key) : [...prev, key],
                      )
                    }
                  />
                );
              })}
            </Stack>
          </Card>
        );
      })}
    </Stack>
  );
}
