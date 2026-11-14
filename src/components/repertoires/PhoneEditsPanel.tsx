import { Badge, Button, Card, Group, Popover, Stack, Switch, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconArrowBackUp, IconDeviceMobile, IconTarget } from "@tabler/icons-react";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import dayjs from "dayjs";
import { useAtom, useAtomValue } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { editHistoryAtom, markUndone } from "@/state/editHistory";
import type { EditEntry } from "@/utils/editHistory";
import { reloadTabs, tabIsDirty, tabsOfFiles } from "@/utils/reloadTabs";
import { applyOp } from "@/utils/repertoireEdit";
import { scheduleSync } from "@/utils/sync";
import { normalizePath } from "@/utils/sync/core";

export type EditFile = { path: string; label: string; rel: string };

const UNDO_SYNC_DELAY = 3_000;

/** Line where to open the repertoire for an edit (the position before a deleted move). */
function lineOf(entry: EditEntry): string[] {
  return entry.op.kind === "delete" ? entry.op.line.slice(0, -1) : entry.op.line;
}

/**
 * Undoes a phone edit in the file on disk: its inverse is applied (like on the phone) and
 * the open tabs of the file are reloaded. Refused while a tab of the file has unsaved
 * changes. Returns false when there was nothing left to undo.
 */
async function undoEntry(entry: EditEntry, path: string): Promise<boolean> {
  const target = normalizePath(path);
  const tabs = tabsOfFiles((p) => normalizePath(p) === target);
  if (tabs.some(tabIsDirty)) throw new Error("dirty");
  const text = await readTextFile(path);
  const result = applyOp(text, entry.game, entry.inverse);
  if (result.changed) await writeTextFile(path, result.text);
  markUndone(entry.id);
  await reloadTabs(tabs);
  scheduleSync(UNDO_SYNC_DELAY, path);
  return result.changed;
}

function EditCard({
  entry,
  file,
  onOpen,
}: {
  entry: EditEntry;
  file: EditFile | undefined;
  onOpen: (path: string, game: number, line: string[]) => void;
}) {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const undone = !!entry.undoneAt;

  const undo = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const changed = await undoEntry(entry, file.path);
      notifications.show({
        color: changed ? "green" : "gray",
        message: changed ? t("Repertoires.Phone.UndoDone") : t("Repertoires.Phone.NothingToUndo"),
      });
    } catch (e) {
      notifications.show({
        color: "red",
        message:
          e instanceof Error && e.message === "dirty"
            ? t("Repertoires.Phone.SaveFirst")
            : String(e),
      });
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  return (
    <Card withBorder p="sm" style={{ opacity: undone ? 0.6 : 1 }}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
          <Group gap="xs">
            <Text fw={600}>{file?.label ?? entry.rel}</Text>
            {undone && (
              <Badge variant="light" color="gray" tt="none">
                {t("Repertoires.Phone.Undone", {
                  date: dayjs(entry.undoneAt).format("DD/MM/YYYY HH:mm"),
                })}
              </Badge>
            )}
          </Group>
          <Text size="sm" td={undone ? "line-through" : undefined}>
            {entry.summary}
          </Text>
          <Text size="xs" c="dimmed">
            {t("Repertoires.Phone.When", {
              date: dayjs(entry.at).format("DD/MM/YYYY HH:mm"),
            })}
          </Text>
        </Stack>
        <Group gap={4} wrap="nowrap">
          <Button
            size="xs"
            variant="light"
            disabled={!file}
            leftSection={<IconTarget size="0.9rem" />}
            onClick={() => file && onOpen(file.path, entry.game, lineOf(entry))}
          >
            {t("Repertoires.Flags.Open")}
          </Button>
          {!undone && (
            <Popover opened={confirm} onChange={setConfirm} withArrow position="bottom-end">
              <Popover.Target>
                <Button
                  size="xs"
                  variant="light"
                  color="orange"
                  disabled={!file}
                  loading={busy}
                  leftSection={<IconArrowBackUp size="0.9rem" />}
                  onClick={() => setConfirm((o) => !o)}
                >
                  {t("Repertoires.Phone.Undo")}
                </Button>
              </Popover.Target>
              <Popover.Dropdown maw={300}>
                <Stack gap="xs">
                  <Text size="sm">{t("Repertoires.Phone.ConfirmUndo")}</Text>
                  <Group justify="flex-end" gap="xs">
                    <Button size="xs" variant="default" onClick={() => setConfirm(false)}>
                      {t("Repertoires.Phone.Keep")}
                    </Button>
                    <Button size="xs" color="orange" loading={busy} onClick={undo}>
                      {t("Repertoires.Phone.UndoConfirm")}
                    </Button>
                  </Group>
                </Stack>
              </Popover.Dropdown>
            </Popover>
          )}
        </Group>
      </Group>
    </Card>
  );
}

/** Edits of the repertoires made on the phone, newest first, each one can be undone. */
export function PhoneEditsPanel({
  files,
  onOpen,
  onSeen,
}: {
  files: EditFile[];
  onOpen: (path: string, game: number, line: string[]) => void;
  onSeen: () => void;
}) {
  const { t } = useTranslation();
  const count = useAtomValue(editHistoryAtom).entries.length;
  // Opened (or new edits arrived while open): they are seen.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => onSeen(), [count]);
  const history = useAtomValue(editHistoryAtom);
  const [showUndone, setShowUndone] = useState(false);
  const byRel = new Map(files.map((f) => [f.rel, f]));
  const list = [...history.entries]
    .filter((e) => e.device === "phone" && (showUndone || !e.undoneAt))
    .reverse();
  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Group gap="xs">
          <IconDeviceMobile size="1rem" />
          <Text size="sm" c="dimmed">
            {t("Repertoires.Phone.Help")}
          </Text>
        </Group>
        <Switch
          size="xs"
          label={t("Repertoires.Phone.ShowUndone")}
          checked={showUndone}
          onChange={(e) => setShowUndone(e.currentTarget.checked)}
        />
      </Group>
      {list.length === 0 ? (
        <Text c="dimmed" ta="center" py="xl">
          {t("Repertoires.Phone.None")}
        </Text>
      ) : (
        list.map((entry) => (
          <EditCard key={entry.id} entry={entry} file={byRel.get(entry.rel)} onOpen={onOpen} />
        ))
      )}
    </Stack>
  );
}

const seenAtom = atomWithStorage<string>("phone-edits-seen", "", undefined, { getOnInit: true });

/** Phone edits arrived since the list was last opened (for the tab's badge). */
export function useNewPhoneEdits(): [number, () => void] {
  const entries = useAtomValue(editHistoryAtom).entries;
  const [seen, setSeen] = useAtom(seenAtom);
  const count = entries.filter((e) => e.device === "phone" && !e.undoneAt && e.at > seen).length;
  return [count, () => setSeen(new Date().toISOString())];
}
