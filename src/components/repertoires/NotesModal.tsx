import { ActionIcon, Badge, Button, Group, Modal, Stack, Text, Tooltip } from "@mantine/core";
import { IconBook, IconNote, IconTrash } from "@tabler/icons-react";
import dayjs from "dayjs";
import { useTranslation } from "react-i18next";
import { formatLine } from "@/utils/noteLine";
import { deleteNote, getNotes } from "@/utils/practiceDecks";
import { liveNotes, type Note } from "@/utils/sync/core";
import { scheduleSync } from "@/utils/sync";

const NOTE_SYNC_DELAY = 5_000;

export type NotesFile = { path: string; name: string };

export function notesCount(paths: string[]): number {
  return paths.reduce((n, p) => n + liveNotes(getNotes(p)).length, 0);
}

/** Small "📝 N" button on repertoire cards and section rows; hidden when there are none. */
export function NotesBadge({ count, onClick }: { count: number; onClick: () => void }) {
  const { t } = useTranslation();
  if (count === 0) return null;
  return (
    <Tooltip label={t("Repertoires.Notes", { count })}>
      <Badge
        size="sm"
        variant="light"
        color="yellow"
        leftSection={<IconNote size="0.8rem" />}
        style={{ cursor: "pointer" }}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        {count}
      </Badge>
    </Tooltip>
  );
}

/**
 * Notes written on the phone (or here) about moves of one or more repertoires. They
 * live outside the PGN: opening one creates a separate analysis tab with its line.
 */
export function NotesModal({
  files,
  onClose,
  onOpen,
}: {
  files: NotesFile[] | null;
  onClose: () => void;
  onOpen: (file: NotesFile, note: Note) => void;
}) {
  const { t } = useTranslation();
  const lists = (files ?? [])
    .map((file) => ({ file, notes: liveNotes(getNotes(file.path)) }))
    .filter((l) => l.notes.length > 0);

  return (
    <Modal opened={files !== null} onClose={onClose} title={t("Repertoires.NotesTitle")} size="lg">
      <Stack>
        {lists.length === 0 && <Text c="dimmed">{t("Repertoires.NoNotes")}</Text>}
        {lists.map(({ file, notes }) => (
          <Stack key={file.path} gap="xs">
            {lists.length > 1 && <Text fw={600}>{file.name}</Text>}
            {notes.map((note) => (
              <Group
                key={note.id}
                wrap="nowrap"
                align="flex-start"
                justify="space-between"
                p="xs"
                style={{
                  borderLeft: "3px solid var(--mantine-color-yellow-6)",
                  background: "var(--mantine-color-default-hover)",
                  borderRadius: "var(--mantine-radius-sm)",
                }}
              >
                <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                  <Text size="sm" c="dimmed">
                    {formatLine(note.startFen, note.line)}
                  </Text>
                  <Text style={{ whiteSpace: "pre-wrap" }}>{note.text}</Text>
                  <Text size="xs" c="dimmed">
                    {note.device} · {dayjs(note.updated).format("DD/MM/YYYY HH:mm")}
                  </Text>
                </Stack>
                <Group gap={4} wrap="nowrap">
                  <Button
                    size="xs"
                    variant="light"
                    leftSection={<IconBook size="0.9rem" />}
                    onClick={() => onOpen(file, note)}
                  >
                    {t("Repertoires.OpenNote")}
                  </Button>
                  <Tooltip label={t("Common.Delete")}>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={t("Common.Delete")}
                      onClick={() => {
                        deleteNote(file.path, note.id);
                        scheduleSync(NOTE_SYNC_DELAY, file.path);
                      }}
                    >
                      <IconTrash size="1rem" />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Group>
            ))}
          </Stack>
        ))}
      </Stack>
    </Modal>
  );
}
