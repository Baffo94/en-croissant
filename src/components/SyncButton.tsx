import { Loader, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCloud, IconCloudCheck, IconCloudX } from "@tabler/icons-react";
import type { TFunction } from "i18next";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import type { SyncSummary } from "@/utils/sync/engine";
import { isConfigured, syncConfigAtom, syncNow, syncStatusAtom } from "@/utils/sync";
import classes from "./Sidebar.module.css";

export function summaryText(t: TFunction, summary: SyncSummary): string {
  return t("Settings.Sync.Summary", {
    uploaded: summary.uploaded,
    downloaded: summary.downloaded,
    progress: summary.progressUpdated,
  });
}

function useStatusLabel(): string {
  const { t } = useTranslation();
  const config = useAtomValue(syncConfigAtom);
  const status = useAtomValue(syncStatusAtom);
  if (!isConfigured(config)) return t("Settings.Sync.Status.NotConfigured");
  if (status.state === "syncing") return t("Settings.Sync.Status.Syncing");
  if (status.state === "error") return `${t("Settings.Sync.Failed")}: ${status.message ?? ""}`;
  if (!status.lastSync) return t("Settings.Sync.Status.Never");
  return t("Settings.Sync.Status.Last", { date: new Date(status.lastSync).toLocaleString() });
}

export function SyncStatusText() {
  const status = useAtomValue(syncStatusAtom);
  const label = useStatusLabel();
  return (
    <Text size="sm" c={status.state === "error" ? "red" : "dimmed"}>
      {label}
    </Text>
  );
}

/** Sidebar button: shows the sync state and syncs on click. Hidden until sync is configured. */
export function SyncButton() {
  const { t } = useTranslation();
  const config = useAtomValue(syncConfigAtom);
  const status = useAtomValue(syncStatusAtom);
  const label = useStatusLabel();

  if (!isConfigured(config)) return null;

  const icon =
    status.state === "syncing" ? (
      <Loader size="1.2rem" />
    ) : status.state === "error" ? (
      <IconCloudX size="1.5rem" stroke={1.5} color="var(--mantine-color-red-6)" />
    ) : status.state === "success" ? (
      <IconCloudCheck size="1.5rem" stroke={1.5} />
    ) : (
      <IconCloud size="1.5rem" stroke={1.5} />
    );

  return (
    <Tooltip label={`${t("SideBar.Sync")} — ${label}`} position="right" multiline maw={300}>
      <UnstyledButton
        className={classes.link}
        aria-label={t("SideBar.Sync")}
        onClick={() => {
          syncNow()
            .then((summary) => {
              if (summary && (summary.downloaded > 0 || summary.conflicts.length > 0)) {
                notifications.show({
                  color: summary.conflicts.length > 0 ? "yellow" : "green",
                  title: t("Settings.Sync.Done"),
                  message: summaryText(t, summary),
                });
              }
            })
            .catch((e) => {
              notifications.show({
                color: "red",
                title: t("Settings.Sync.Failed"),
                message: e instanceof Error ? e.message : String(e),
              });
            });
        }}
      >
        {icon}
      </UnstyledButton>
    </Tooltip>
  );
}
