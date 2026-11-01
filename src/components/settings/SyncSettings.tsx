import {
  Alert,
  Anchor,
  Button,
  Group,
  PasswordInput,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCloudCheck, IconPlugConnected } from "@tabler/icons-react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAtom, useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  isConfigured,
  parseRepository,
  resolveSyncFolder,
  syncConfigAtom,
  syncNow,
  syncStatusAtom,
  testConnection,
} from "@/utils/sync";
import FileInput from "../common/FileInput";
import { SyncStatusText, summaryText } from "../SyncButton";

const TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

export default function SyncSettings() {
  const { t } = useTranslation();
  const [config, setConfig] = useAtom(syncConfigAtom);
  const status = useAtomValue(syncStatusAtom);
  const [folder, setFolder] = useState("");
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    resolveSyncFolder(config).then(setFolder);
  }, [config]);

  const repoValid = config.repository.trim() === "" || parseRepository(config.repository) !== null;

  async function onTest() {
    setTesting(true);
    try {
      const result = await testConnection(config);
      if (!result.push) {
        notifications.show({
          color: "red",
          title: t("Common.Error"),
          message: t("Settings.Sync.TestNoPush"),
        });
      } else if (!result.private) {
        notifications.show({
          color: "yellow",
          title: t("Settings.Sync.TestOk"),
          message: t("Settings.Sync.TestPublic"),
        });
      } else {
        notifications.show({
          color: "green",
          title: t("Settings.Sync.TestOk"),
          message: config.repository,
        });
      }
    } catch (e) {
      notifications.show({
        color: "red",
        title: t("Common.Error"),
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTesting(false);
    }
  }

  async function onSync() {
    try {
      const summary = await syncNow();
      if (summary) {
        notifications.show({
          color: "green",
          title: t("Settings.Sync.Done"),
          message: summaryText(t, summary),
        });
      }
    } catch (e) {
      notifications.show({
        color: "red",
        title: t("Settings.Sync.Failed"),
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <Stack gap="md">
      <Text size="sm">
        {t("Settings.Sync.Help")}{" "}
        <Anchor component="button" size="sm" onClick={() => openUrl(TOKEN_URL)}>
          github.com/settings/personal-access-tokens
        </Anchor>
      </Text>

      <TextInput
        label={t("Settings.Sync.Repository")}
        description={t("Settings.Sync.Repository.Desc")}
        placeholder="username/repertorio"
        value={config.repository}
        error={repoValid ? undefined : t("Settings.Sync.Repository.Invalid")}
        onChange={(e) => {
          const repository = e.currentTarget.value;
          setConfig((c) => ({ ...c, repository }));
        }}
      />
      <PasswordInput
        label={t("Settings.Sync.Token")}
        description={t("Settings.Sync.Token.Desc")}
        placeholder="github_pat_..."
        value={config.token}
        onChange={(e) => {
          const token = e.currentTarget.value;
          setConfig((c) => ({ ...c, token }));
        }}
      />
      <TextInput
        label={t("Settings.Sync.Branch")}
        description={t("Settings.Sync.Branch.Desc")}
        placeholder="main"
        value={config.branch}
        onChange={(e) => {
          const branch = e.currentTarget.value;
          setConfig((c) => ({ ...c, branch }));
        }}
      />
      <FileInput
        label={t("Settings.Sync.Folder")}
        description={t("Settings.Sync.Folder.Desc")}
        filename={folder || null}
        onClick={async () => {
          const selected = await open({ multiple: false, directory: true });
          if (!selected || typeof selected !== "string") return;
          setConfig((c) => ({ ...c, folder: selected }));
        }}
      />
      <Switch
        label={t("Settings.Sync.Auto")}
        description={t("Settings.Sync.Auto.Desc")}
        checked={config.auto}
        onChange={(e) => {
          const auto = e.currentTarget.checked;
          setConfig((c) => ({ ...c, auto }));
        }}
      />

      <Group>
        <Button
          variant="default"
          leftSection={<IconPlugConnected size="1rem" />}
          loading={testing}
          disabled={!isConfigured(config)}
          onClick={onTest}
        >
          {t("Settings.Sync.Test")}
        </Button>
        <Button
          leftSection={<IconCloudCheck size="1rem" />}
          loading={status.state === "syncing"}
          disabled={!isConfigured(config)}
          onClick={onSync}
        >
          {t("Settings.Sync.Now")}
        </Button>
      </Group>

      <SyncStatusText />

      {status.summary && status.summary.conflicts.length > 0 && (
        <Alert color="yellow">
          {t("Settings.Sync.Conflicts", { files: status.summary.conflicts.join(", ") })}
        </Alert>
      )}
    </Stack>
  );
}
