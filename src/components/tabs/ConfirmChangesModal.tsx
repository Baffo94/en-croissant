import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useLoaderData } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { tabsAtom } from "@/state/atoms";
import type { TreeStore } from "@/state/store/tree";
import { saveToFile, type Tab } from "@/utils/tabs";

function ConfirmChangesModal({
  opened,
  onClose,
  onConfirm,
  tab,
  getStore,
}: {
  opened: boolean;
  onClose: () => void;
  onConfirm: () => void;
  tab: Tab;
  getStore: () => TreeStore | undefined;
}) {
  const setTabs = useSetAtom(tabsAtom);
  const { documentDir } = useLoaderData({ from: "/" });
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  function dismiss() {
    setSaveFailed(false);
    onClose();
  }

  function confirm() {
    onConfirm();
    dismiss();
  }

  async function saveAndConfirm() {
    setSaving(true);
    setSaveFailed(false);
    let saved: boolean;
    try {
      const store = getStore();
      if (!store) {
        setSaveFailed(true);
        return;
      }
      saved = await saveToFile({
        dir: documentDir,
        setTabs,
        tab,
        store,
        isUserSave: true,
      });
    } catch {
      setSaveFailed(true);
      return;
    } finally {
      setSaving(false);
    }
    if (saved) confirm();
  }

  return (
    <Modal
      withCloseButton={false}
      opened={opened}
      onClose={dismiss}
      closeOnEscape={!saving}
      closeOnClickOutside={!saving}
    >
      <Stack>
        <div>
          <Text fz="lg" fw="bold" mb={10}>
            {t("Tabs.Unsaved.Title")}
          </Text>
          <Text>{t("Tabs.Unsaved.Text")}</Text>
        </div>

        {saveFailed && (
          <Text role="alert" c="red">
            {t("Tabs.Unsaved.SaveFailed")}
          </Text>
        )}
        <Group justify="right">
          <Button variant="default" disabled={saving} onClick={confirm}>
            {t("Tabs.Unsaved.CloseWithoutSaving")}
          </Button>
          <Button loading={saving} onClick={saveAndConfirm}>
            {t("Tabs.Unsaved.SaveAndClose")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export default ConfirmChangesModal;
