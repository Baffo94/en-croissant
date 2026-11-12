import { Button, Group, Switch, Text } from "@mantine/core";
import { useAtom } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { commands } from "@/bindings";
import { evalCacheSettingsAtom } from "@/state/atoms";

/** Use the local database of opening evaluations. */
export function EvalCacheEnabled() {
  const [settings, setSettings] = useAtom(evalCacheSettingsAtom);
  return (
    <Switch
      checked={settings.enabled}
      onChange={(e) => setSettings({ ...settings, enabled: e.currentTarget.checked })}
    />
  );
}

/** Ask the Lichess cloud for opening positions not yet evaluated deeply enough. */
export function EvalCacheCloud() {
  const [settings, setSettings] = useAtom(evalCacheSettingsAtom);
  return (
    <Switch
      checked={settings.cloud}
      disabled={!settings.enabled}
      onChange={(e) => setSettings({ ...settings, cloud: e.currentTarget.checked })}
    />
  );
}

/** Size of the database, with a button to empty it. */
export function EvalCacheSize() {
  const { t, i18n } = useTranslation();
  const [clearing, setClearing] = useState(false);
  const { data, mutate } = useSWR("eval-cache-stats", async () => {
    const r = await commands.evalCacheStats();
    return r.status === "ok" ? r.data : null;
  });
  return (
    <Group gap="sm">
      <Text size="sm" c="dimmed">
        {data
          ? t("Settings.EvalCache.Size", {
              count: data.positions,
              positions: data.positions.toLocaleString(i18n.language),
              mb: (data.bytes / 1024 / 1024).toLocaleString(i18n.language, {
                maximumFractionDigits: 1,
              }),
            })
          : "…"}
      </Text>
      <Button
        size="xs"
        variant="default"
        loading={clearing}
        disabled={!data?.positions}
        onClick={async () => {
          setClearing(true);
          await commands.evalCacheClear();
          await mutate();
          setClearing(false);
        }}
      >
        {t("Settings.EvalCache.Clear")}
      </Button>
    </Group>
  );
}
