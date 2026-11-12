import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  Stack,
  Switch,
  Text,
  Textarea,
  Tooltip,
} from "@mantine/core";
import { IconCheck, IconFlag, IconPencil, IconTarget } from "@tabler/icons-react";
import dayjs from "dayjs";
import { atom, useAtomValue } from "jotai";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { flagMoveLabel, openFlags, type ReviewFlag, resolveFlag } from "@/utils/flags";
import { flagsAtomOf, getFlags, setFlags } from "@/utils/practiceDecks";

type FlagFile = { path: string; label: string };

type Listed = { file: FlagFile; flag: ReviewFlag };

/** Flags of every repertoire, reactive (a sync or the phone may add some). */
export function useAllFlags(files: readonly FlagFile[]): Listed[] {
  const combined = useMemo(
    () =>
      atom((get) =>
        files.flatMap((file) => get(flagsAtomOf(file.path)).map((flag) => ({ file, flag }))),
      ),
    [files],
  );
  return useAtomValue(combined);
}

function updateFlag(path: string, id: string, change: (f: ReviewFlag) => ReviewFlag) {
  setFlags(
    path,
    getFlags(path).map((f) => (f.id === id ? change(f) : f)),
  );
}

function FlagCard({
  item,
  onOpen,
}: {
  item: Listed;
  onOpen: (path: string, game: number, line: string[]) => void;
}) {
  const { t } = useTranslation();
  const { file, flag } = item;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(flag.text);
  const resolved = !!flag.resolvedAt;
  return (
    <Card withBorder p="sm" style={{ opacity: resolved ? 0.6 : 1 }}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
          <Group gap="xs">
            <Text fw={600}>{file.label}</Text>
            <Badge variant="light" color="red" tt="none" leftSection={<IconFlag size="0.8rem" />}>
              {flagMoveLabel(flag)}
            </Badge>
          </Group>
          {editing ? (
            <Stack gap={6}>
              <Textarea
                autosize
                minRows={2}
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.currentTarget.value)}
              />
              <Group gap="xs">
                <Button
                  size="xs"
                  disabled={!draft.trim()}
                  onClick={() => {
                    const now = new Date().toISOString();
                    updateFlag(file.path, flag.id, (f) => ({
                      ...f,
                      text: draft.trim(),
                      updatedAt: now,
                    }));
                    setEditing(false);
                  }}
                >
                  {t("Repertoires.Flags.Save")}
                </Button>
                <Button size="xs" variant="default" onClick={() => setEditing(false)}>
                  {t("Repertoires.Ideas.Cancel")}
                </Button>
              </Group>
            </Stack>
          ) : (
            <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
              {flag.text}
            </Text>
          )}
          <Text size="xs" c="dimmed">
            {t("Repertoires.Flags.From", {
              device: flag.device,
              date: dayjs(flag.createdAt).format("DD/MM/YYYY HH:mm"),
            })}
            {resolved
              ? ` · ${t("Repertoires.Flags.ResolvedOn", {
                  date: dayjs(flag.resolvedAt).format("DD/MM/YYYY"),
                })}`
              : ""}
          </Text>
        </Stack>
        <Group gap={4} wrap="nowrap">
          <Button
            size="xs"
            variant="light"
            leftSection={<IconTarget size="0.9rem" />}
            onClick={() => onOpen(file.path, flag.game, flag.line)}
          >
            {t("Repertoires.Flags.Open")}
          </Button>
          {!resolved && (
            <>
              <Tooltip label={t("Repertoires.Flags.Edit")}>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  onClick={() => {
                    setDraft(flag.text);
                    setEditing(true);
                  }}
                >
                  <IconPencil size="1rem" />
                </ActionIcon>
              </Tooltip>
              <Button
                size="xs"
                color="green"
                variant="light"
                leftSection={<IconCheck size="0.9rem" />}
                onClick={() => setFlags(file.path, resolveFlag(getFlags(file.path), flag.id))}
              >
                {t("Repertoires.Flags.Resolve")}
              </Button>
            </>
          )}
        </Group>
      </Group>
    </Card>
  );
}

/** Moves flagged to review (from the phone or here), newest first. */
export function FlagsPanel({
  files,
  onOpen,
}: {
  files: FlagFile[];
  onOpen: (path: string, game: number, line: string[]) => void;
}) {
  const { t } = useTranslation();
  const [showResolved, setShowResolved] = useState(false);
  const all = useAllFlags(files);
  const open = all.filter((i) => !i.flag.resolvedAt);
  const list = [...(showResolved ? all : open)].sort((a, b) =>
    b.flag.createdAt.localeCompare(a.flag.createdAt),
  );
  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {t("Repertoires.Flags.Help")}
        </Text>
        <Switch
          size="xs"
          label={t("Repertoires.Flags.ShowResolved")}
          checked={showResolved}
          onChange={(e) => setShowResolved(e.currentTarget.checked)}
        />
      </Group>
      {list.length === 0 ? (
        <Text c="dimmed" ta="center" py="xl">
          {t("Repertoires.Flags.None")}
        </Text>
      ) : (
        list.map((item) => (
          <FlagCard key={`${item.file.path}-${item.flag.id}`} item={item} onOpen={onOpen} />
        ))
      )}
    </Stack>
  );
}

/** Number of open flags of the given repertoires. */
export function useOpenFlagCount(files: readonly FlagFile[]): number {
  return openFlags(useAllFlags(files).map((i) => i.flag)).length;
}
