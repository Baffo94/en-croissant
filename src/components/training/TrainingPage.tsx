import { ScrollArea, Stack, Tabs, Text, Title } from "@mantine/core";
import { IconChessKnight, IconListSearch, IconTarget } from "@tabler/icons-react";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useTranslation } from "react-i18next";
import { CandidatesPanel } from "./CandidatesPanel";
import { EndgamesPanel } from "./EndgamesPanel";
import { TacticsPanel } from "./TacticsPanel";

const tabAtom = atomWithStorage<string>("training-tab", "tactics", undefined, {
  getOnInit: true,
});

export default function TrainingPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useAtom(tabAtom);

  return (
    <Stack h="100%" gap={0}>
      <div style={{ padding: "var(--mantine-spacing-lg) var(--mantine-spacing-lg) 0" }}>
        <Title order={2}>{t("Training.Title")}</Title>
        <Text c="dimmed" size="sm">
          {t("Training.Subtitle")}
        </Text>
      </div>
      <Tabs
        value={tab}
        onChange={(v) => v && setTab(v)}
        keepMounted={false}
        flex={1}
        mih={0}
        style={{ display: "flex", flexDirection: "column" }}
      >
        <Tabs.List px="lg" pt="sm">
          <Tabs.Tab value="tactics" leftSection={<IconTarget size="1rem" />}>
            {t("Training.Tabs.Tactics")}
          </Tabs.Tab>
          <Tabs.Tab value="endgames" leftSection={<IconChessKnight size="1rem" />}>
            {t("Training.Tabs.Endgames")}
          </Tabs.Tab>
          <Tabs.Tab value="candidates" leftSection={<IconListSearch size="1rem" />}>
            {t("Training.Tabs.Candidates")}
          </Tabs.Tab>
        </Tabs.List>
        <ScrollArea flex={1} px="lg" py="md">
          <Tabs.Panel value="tactics">
            <TacticsPanel />
          </Tabs.Panel>
          <Tabs.Panel value="endgames">
            <EndgamesPanel />
          </Tabs.Panel>
          <Tabs.Panel value="candidates">
            <CandidatesPanel />
          </Tabs.Panel>
        </ScrollArea>
      </Tabs>
    </Stack>
  );
}
