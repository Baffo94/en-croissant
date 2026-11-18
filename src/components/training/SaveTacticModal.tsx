import { Alert, Autocomplete, Button, Group, Modal, Stack, TagsInput, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle } from "@tabler/icons-react";
import { atomWithStorage } from "jotai/utils";
import { useAtom } from "jotai";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { normalizeTags, tacticProblem, tagsOf } from "@/utils/training/myTactics";
import { cleanCollectionName, listCollections, saveTactic } from "@/utils/training/tacticsFiles";
import type { TreeNode } from "@/utils/treeReducer";

/** The last collection used: the next tactic of the same book goes there too. */
const lastCollectionAtom = atomWithStorage("tactics-last-collection", "", undefined, {
  getOnInit: true,
});

export function SaveTacticModal({
  opened,
  onClose,
  root,
}: {
  opened: boolean;
  onClose: () => void;
  root: TreeNode;
}) {
  const { t } = useTranslation();
  const { data: collections, mutate } = useSWR(
    opened ? "tactic-collections" : null,
    listCollections,
  );
  const [last, setLast] = useAtom(lastCollectionAtom);
  const [collection, setCollection] = useState(last);
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (opened) {
      setCollection(last);
      setTags([]);
    }
  }, [opened, last]);

  const problem = tacticProblem(root);
  const name = cleanCollectionName(collection);
  const known = collections?.find((c) => c.name.toLowerCase() === name.toLowerCase());
  const allTags = tagsOf((collections ?? []).flatMap((c) => c.tactics));
  const solution: string[] = [];
  for (let n = root.children[0]; n && solution.length < 6; n = n.children[0]) {
    if (n.san) solution.push(n.san);
  }

  async function save() {
    if (problem || !name) return;
    setBusy(true);
    try {
      await saveTactic(known?.name ?? name, normalizeTags(tags), root);
      setLast(known?.name ?? name);
      await mutate();
      notifications.show({
        color: "green",
        message: t("Training.MyTactics.Saved", { collection: known?.name ?? name }),
      });
      onClose();
    } catch (e) {
      notifications.show({
        color: "red",
        title: t("Common.Error"),
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title={t("Training.MyTactics.SaveTitle")}>
      <Stack gap="sm">
        {problem ? (
          <Alert color="orange" icon={<IconAlertTriangle size="1rem" />}>
            {t("Training.MyTactics.NoSolution")}
          </Alert>
        ) : (
          <Text size="sm" c="dimmed">
            {t("Training.MyTactics.SaveHelp", {
              line: solution.join(" ") + (root.children[0] && solution.length >= 6 ? " …" : ""),
            })}
          </Text>
        )}
        <Autocomplete
          label={t("Training.MyTactics.Collection")}
          placeholder={t("Training.MyTactics.CollectionPlaceholder")}
          data={(collections ?? []).map((c) => c.name)}
          value={collection}
          onChange={setCollection}
          description={
            name && !known && collections
              ? t("Training.MyTactics.NewCollection", { name })
              : undefined
          }
          data-autofocus
        />
        <TagsInput
          label={t("Training.MyTactics.Tags")}
          placeholder={t("Training.MyTactics.TagsPlaceholder")}
          data={allTags}
          value={tags}
          onChange={(v) => setTags(normalizeTags(v))}
          clearable
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t("Common.Cancel")}
          </Button>
          <Button onClick={save} loading={busy} disabled={!!problem || !name}>
            {t("Training.MyTactics.Save")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
