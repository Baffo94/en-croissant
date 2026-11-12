import { Alert, Button, Group, List, Modal, Stack, Text, Textarea } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconBulb, IconPencil } from "@tabler/icons-react";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { tabsAtom } from "@/state/atoms";
import { ideaPoints, ideasDraft, ideasText } from "@/utils/ideas";
import { getMoveComment, setMoveComment } from "@/utils/pgnEdit";
import { getTabFile } from "@/utils/tabs";

/**
 * The ideas of a section: a list of points kept as the comment before the first move of
 * its PGN (the same comment En Croissant shows at the starting position).
 */
export function IdeasModal({
  file,
  title,
  onClose,
  onSaved,
}: {
  file: { path: string } | null;
  title: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const tabs = useAtomValue(tabsAtom);
  const [text, setText] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setText(null);
    setEditing(false);
    if (!file) return;
    readTextFile(file.path)
      .then((pgn) => {
        const ideas = getMoveComment(pgn, 0, []);
        setText(ideas);
        if (!ideaPoints(ideas).length) {
          setDraft("");
          setEditing(true);
        }
      })
      .catch((e) => {
        notifications.show({ color: "red", message: String(e) });
        onClose();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.path]);

  const openInTab = file ? tabs.some((tab) => getTabFile(tab)?.path === file.path) : false;
  const points = ideaPoints(text ?? "");

  const save = async () => {
    if (!file) return;
    setSaving(true);
    try {
      const pgn = await readTextFile(file.path);
      const value = ideasText(draft);
      const next = setMoveComment(pgn, 0, [], value);
      if (next === null) throw new Error(t("Repertoires.Ideas.NotSaved"));
      if (next !== pgn) await writeTextFile(file.path, next);
      setText(value);
      setEditing(false);
      onSaved();
    } catch (e) {
      notifications.show({ color: "red", message: String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      opened={file !== null}
      onClose={onClose}
      size="lg"
      title={
        <Group gap={6}>
          <IconBulb size="1.1rem" />
          <Text fw={600}>{t("Repertoires.Ideas.Title", { name: title })}</Text>
        </Group>
      }
    >
      {text === null ? null : editing ? (
        <Stack gap="sm">
          {openInTab && <Alert color="yellow">{t("Repertoires.Ideas.OpenInTab")}</Alert>}
          <Textarea
            autosize
            minRows={6}
            maxRows={18}
            autoFocus
            value={draft}
            placeholder={t("Repertoires.Ideas.Placeholder")}
            onChange={(e) => setDraft(e.currentTarget.value)}
            disabled={openInTab}
          />
          <Text size="xs" c="dimmed">
            {t("Repertoires.Ideas.Help")}
          </Text>
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => (points.length ? setEditing(false) : onClose())}
            >
              {t("Repertoires.Ideas.Cancel")}
            </Button>
            <Button onClick={save} loading={saving} disabled={openInTab}>
              {t("Common.Save")}
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap="sm">
          <List spacing={6}>
            {points.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: points can repeat
              <List.Item key={i}>{p}</List.Item>
            ))}
          </List>
          <Group justify="flex-end">
            <Button
              variant="light"
              leftSection={<IconPencil size="1rem" />}
              onClick={() => {
                setDraft(ideasDraft(text));
                setEditing(true);
              }}
            >
              {t("Repertoires.Ideas.Edit")}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
