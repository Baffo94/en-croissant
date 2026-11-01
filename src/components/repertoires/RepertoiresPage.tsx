import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Menu,
  RingProgress,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconBook,
  IconCloud,
  IconCloudCheck,
  IconDots,
  IconFolderOpen,
  IconPencil,
  IconPlus,
  IconSearch,
  IconTarget,
  IconTrash,
} from "@tabler/icons-react";
import { useLoaderData, useNavigate } from "@tanstack/react-router";
import { exists, mkdir, readDir, remove } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import dayjs from "dayjs";
import "dayjs/locale/it";
import relativeTime from "dayjs/plugin/relativeTime";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { commands } from "@/bindings";
import ConfirmModal from "@/components/common/ConfirmModal";
import {
  type Directory,
  type FileMetadata,
  processEntriesRecursively,
} from "@/components/files/file";
import { EditModal } from "@/components/files/Modals";
import { buildFromTree, getStats, type PracticeData } from "@/components/files/opening";
import { SyncStatusText, summaryText } from "@/components/SyncButton";
import CreateRepertoireModal from "@/components/tabs/CreateRepertoireModal";
import {
  activeTabAtom,
  addRecentFileAtom,
  deckAtomFamily,
  tabFamily,
  tabsAtom,
} from "@/state/atoms";
import { parsePGN } from "@/utils/chess";
import { decksOfFile, removeDecks } from "@/utils/practiceDecks";
import {
  isConfigured,
  resolveSyncFolder,
  syncConfigAtom,
  syncNow,
  syncStatusAtom,
} from "@/utils/sync";
import { normalizePath, relativePath } from "@/utils/sync/core";
import { createTab } from "@/utils/tabs";
import { unwrap } from "@/utils/unwrap";

dayjs.extend(relativeTime);

type RepertoireFile = FileMetadata & { inSyncFolder: boolean; folder: string };

function flatten(entries: (FileMetadata | Directory)[]): FileMetadata[] {
  return entries.flatMap((e) => (e.type === "directory" ? flatten(e.children) : [e]));
}

async function listRepertoires(documentDir: string, syncFolder: string | null) {
  const roots = [documentDir];
  if (syncFolder && relativePath(documentDir, syncFolder) === null) {
    if (normalizePath(syncFolder) !== normalizePath(documentDir)) roots.push(syncFolder);
  }
  const files: RepertoireFile[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!(await exists(root))) continue;
    for (const file of flatten(await processEntriesRecursively(root, await readDir(root)))) {
      if (file.metadata.type !== "repertoire" || seen.has(normalizePath(file.path))) continue;
      seen.add(normalizePath(file.path));
      const rel = relativePath(root, file.path) ?? file.name;
      const folder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      files.push({
        ...file,
        folder,
        inSyncFolder: syncFolder !== null && relativePath(syncFolder, file.path) !== null,
      });
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/** Orientation and positions of the first game, parsed from the PGN. */
function useRepertoireInfo(file: RepertoireFile) {
  return useSWR(["repertoire-info", file.path, file.lastModified], async () => {
    const pgn = unwrap(await commands.readGames(file.path, 0, 0))[0] ?? "";
    const tree = await parsePGN(pgn);
    const orientation = tree.headers.orientation === "black" ? "black" : "white";
    const positions = buildFromTree(tree.root, orientation, tree.headers.start ?? []);
    return { orientation, positions: positions.length } as const;
  });
}

type CardStats = {
  total: number;
  due: number;
  unseen: number;
  learned: number;
  nextDue: Date | null;
  lastReview: Date | null;
  reviews: number;
};

function cardStats(decks: Record<number, PracticeData>, fallbackTotal: number): CardStats {
  const all = Object.values(decks);
  const positions = all.flatMap((d) => d.positions);
  if (positions.length === 0) {
    return {
      total: fallbackTotal,
      due: 0,
      unseen: fallbackTotal,
      learned: 0,
      nextDue: null,
      lastReview: null,
      reviews: 0,
    };
  }
  const stats = getStats(positions);
  let lastReview: Date | null = null;
  let reviews = 0;
  for (const deck of all) {
    for (const log of deck.logs) {
      reviews++;
      const date = new Date(log.review);
      if (!lastReview || date > lastReview) lastReview = date;
    }
  }
  return {
    total: stats.total,
    due: stats.due,
    unseen: stats.unseen,
    learned: stats.practiced,
    nextDue: stats.nextDue,
    lastReview,
    reviews,
  };
}

function RepertoireCard({
  file,
  onOpen,
  onRename,
  onDelete,
  onToDo,
}: {
  file: RepertoireFile;
  onToDo: (path: string, count: number) => void;
  onOpen: (file: RepertoireFile, practice: boolean) => void;
  onRename: (file: RepertoireFile) => void;
  onDelete: (file: RepertoireFile) => void;
}) {
  const { t, i18n } = useTranslation();
  const fromNow = (date: Date) =>
    dayjs(date)
      .locale(i18n.language?.slice(0, 2) === "it" ? "it" : "en")
      .fromNow();
  // Subscribing to game 0 re-renders the card when practice progress changes.
  useAtomValue(deckAtomFamily({ file: file.path, game: 0 }));
  const { data: info } = useRepertoireInfo(file);
  const stats = cardStats(decksOfFile(file.path), info?.positions ?? 0);
  const toDo = stats.due + stats.unseen;
  const pct = (n: number) => (stats.total > 0 ? (n / stats.total) * 100 : 0);
  const mastery = Math.round(pct(stats.learned));
  useEffect(() => onToDo(file.path, toDo), [file.path, toDo, onToDo]);

  return (
    <Card withBorder radius="md" padding="md">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <Box
            w={18}
            h={18}
            style={{
              flexShrink: 0,
              borderRadius: "50%",
              border: "2px solid var(--mantine-color-gray-5)",
              background: info?.orientation === "black" ? "#000" : "#fff",
            }}
          />
          <div style={{ minWidth: 0 }}>
            <Text fw={600} truncate>
              {file.name}
            </Text>
            <Text size="xs" c="dimmed" truncate>
              {info?.orientation === "black" ? t("Common.BLACK") : t("Common.WHITE")}
              {file.folder ? ` · ${file.folder}` : ""}
              {file.numGames > 1 ? ` · ${t("Repertoires.Games", { count: file.numGames })}` : ""}
            </Text>
          </div>
        </Group>
        <Group gap={4} wrap="nowrap">
          {file.inSyncFolder && (
            <Tooltip label={t("Repertoires.Synced")}>
              <IconCloud size="1rem" style={{ color: "var(--mantine-color-dimmed)" }} />
            </Tooltip>
          )}
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" aria-label={t("Repertoires.Actions")}>
                <IconDots size="1rem" />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconBook size="1rem" />} onClick={() => onOpen(file, false)}>
                {t("Repertoires.Open")}
              </Menu.Item>
              <Menu.Item leftSection={<IconPencil size="1rem" />} onClick={() => onRename(file)}>
                {t("Repertoires.Rename")}
              </Menu.Item>
              <Menu.Item
                leftSection={<IconFolderOpen size="1rem" />}
                onClick={() =>
                  openPath(
                    file.path.slice(
                      0,
                      Math.max(file.path.lastIndexOf("/"), file.path.lastIndexOf("\\")),
                    ),
                  )
                }
              >
                {t("Repertoires.ShowInFolder")}
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item
                color="red"
                leftSection={<IconTrash size="1rem" />}
                onClick={() => onDelete(file)}
              >
                {t("Common.Delete")}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>

      <Group mt="md" wrap="nowrap" gap="md">
        <RingProgress
          size={84}
          thickness={8}
          roundCaps={stats.learned + stats.due > 0}
          sections={[
            {
              value: pct(stats.learned),
              color: "teal",
              tooltip: t("Repertoires.Learned", { count: stats.learned }),
            },
            {
              value: pct(stats.due),
              color: "orange",
              tooltip: t("Repertoires.Due", { count: stats.due }),
            },
          ]}
          label={
            <Text ta="center" size="sm" fw={700}>
              {mastery}%
            </Text>
          }
        />
        <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
          <Group gap={6}>
            {stats.due > 0 && (
              <Badge color="orange" variant="light">
                {t("Repertoires.Due", { count: stats.due })}
              </Badge>
            )}
            {stats.unseen > 0 && (
              <Badge color="blue" variant="light">
                {t("Repertoires.NewPositions", { count: stats.unseen })}
              </Badge>
            )}
            {toDo === 0 && stats.total > 0 && (
              <Badge color="teal" variant="light">
                {t("Repertoires.UpToDate")}
              </Badge>
            )}
          </Group>
          <Text size="xs" c="dimmed">
            {t("Repertoires.Positions", { count: stats.total })}
          </Text>
          <Text size="xs" c="dimmed">
            {stats.lastReview
              ? t("Repertoires.LastPractice", { when: fromNow(stats.lastReview) })
              : t("Repertoires.NeverPracticed")}
          </Text>
          {toDo === 0 && stats.nextDue && (
            <Text size="xs" c="dimmed">
              {t("Repertoires.NextReview", { when: fromNow(stats.nextDue) })}
            </Text>
          )}
        </Stack>
      </Group>

      <Group mt="md" grow>
        <Button
          leftSection={<IconTarget size="1rem" />}
          variant={toDo > 0 ? "filled" : "light"}
          onClick={() => onOpen(file, true)}
        >
          {toDo > 0 ? t("Repertoires.Practice", { count: toDo }) : t("Repertoires.PracticeAnyway")}
        </Button>
        <Button
          variant="default"
          leftSection={<IconBook size="1rem" />}
          onClick={() => onOpen(file, false)}
        >
          {t("Repertoires.Open")}
        </Button>
      </Group>
    </Card>
  );
}

export default function RepertoiresPage() {
  const { t } = useTranslation();
  const { documentDir } = useLoaderData({ from: "/repertoires" });
  const syncConfig = useAtomValue(syncConfigAtom);
  const syncStatus = useAtomValue(syncStatusAtom);
  const syncEnabled = isConfigured(syncConfig);
  const [search, setSearch] = useState("");
  const [color, setColor] = useState<"all" | "white" | "black">("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [createDir, setCreateDir] = useState<string | undefined>(undefined);
  const [renaming, setRenaming] = useState<RepertoireFile | null>(null);
  const [deleting, setDeleting] = useState<RepertoireFile | null>(null);

  const [, setTabs] = useAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const store = useStore();
  const navigate = useNavigate();

  const { data: syncFolder } = useSWR(syncEnabled ? ["sync-folder", syncConfig.folder] : null, () =>
    resolveSyncFolder(syncConfig),
  );
  const {
    data: files,
    isLoading,
    mutate,
  } = useSWR(["repertoires", documentDir, syncFolder ?? null, syncStatus.lastSync], () =>
    listRepertoires(documentDir, syncFolder ?? null),
  );

  // Orientation is needed to filter by colour; the cards share the SWR cache.
  const { data: orientations } = useSWR(
    files
      ? ["repertoire-orientations", files.map((f) => `${f.path}:${f.lastModified}`).join("|")]
      : null,
    async () => {
      const result: Record<string, "white" | "black"> = {};
      for (const file of files ?? []) {
        try {
          const pgn = unwrap(await commands.readGames(file.path, 0, 0))[0] ?? "";
          const match = /\[Orientation "(white|black)"\]/.exec(pgn);
          result[file.path] = match?.[1] === "black" ? "black" : "white";
        } catch {
          result[file.path] = "white";
        }
      }
      return result;
    },
  );

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (files ?? []).filter(
      (f) =>
        (!query ||
          f.name.toLowerCase().includes(query) ||
          f.folder.toLowerCase().includes(query)) &&
        (color === "all" || (orientations?.[f.path] ?? "white") === color),
    );
  }, [files, search, color, orientations]);

  // Each card reports how many positions it has to practice (it knows the PGN).
  const [toDoByFile, setToDoByFile] = useState<Record<string, number>>({});
  const reportToDo = useCallback((path: string, count: number) => {
    setToDoByFile((prev) => (prev[path] === count ? prev : { ...prev, [path]: count }));
  }, []);
  const totals = useMemo(() => {
    const paths = new Set((files ?? []).map((f) => f.path));
    let toDo = 0;
    for (const [path, count] of Object.entries(toDoByFile)) if (paths.has(path)) toDo += count;
    return { toDo };
  }, [files, toDoByFile]);

  async function openRepertoire(file: RepertoireFile, practice: boolean) {
    const [pgnResult, countResult] = await Promise.all([
      commands.readGames(file.path, 0, 0),
      commands.countPgnGames(file.path),
    ]);
    const pgn = unwrap(pgnResult)[0] ?? "";
    const tabId = await createTab({
      tab: { name: file.name, type: "analysis" },
      setTabs,
      setActiveTab,
      pgn,
      gameOrigin: {
        kind: "file",
        gameNumber: 0,
        file: { ...file, numGames: unwrap(countResult) },
      },
    });
    if (practice) store.set(tabFamily(tabId), "practice");
    store.set(addRecentFileAtom, { name: file.name, path: file.path, type: "repertoire" });
    navigate({ to: "/" });
  }

  async function startCreate() {
    let dir = documentDir;
    if (syncEnabled && syncFolder) {
      if (!(await exists(syncFolder))) await mkdir(syncFolder, { recursive: true });
      dir = syncFolder;
    }
    setCreateDir(dir);
    setCreateOpen(true);
  }

  async function confirmDelete(file: RepertoireFile) {
    try {
      await remove(file.path);
      const info = file.path.replace(/\.pgn$/i, ".info");
      if (await exists(info)) await remove(info);
      removeDecks(file.path);
    } catch (e) {
      notifications.show({ color: "red", title: t("Common.Error"), message: String(e) });
    }
    setDeleting(null);
    mutate();
  }

  return (
    <Stack h="100%" gap={0}>
      <Group px="lg" pt="lg" pb="sm" justify="space-between" align="flex-end">
        <div>
          <Title order={2}>{t("Repertoires.Title")}</Title>
          <Text c="dimmed" size="sm">
            {files && files.length > 0
              ? totals.toDo > 0
                ? t("Repertoires.Summary", { count: totals.toDo })
                : t("Repertoires.AllDone")
              : t("Repertoires.Subtitle")}
          </Text>
        </div>
        <Group>
          {syncEnabled && (
            <Group gap="xs">
              <SyncStatusText />
              <Button
                variant="default"
                leftSection={<IconCloudCheck size="1rem" />}
                loading={syncStatus.state === "syncing"}
                onClick={() =>
                  syncNow()
                    .then((summary) => {
                      if (summary) {
                        notifications.show({
                          color: "green",
                          title: t("Settings.Sync.Done"),
                          message: summaryText(t, summary),
                        });
                      }
                      mutate();
                    })
                    .catch((e) =>
                      notifications.show({
                        color: "red",
                        title: t("Settings.Sync.Failed"),
                        message: e instanceof Error ? e.message : String(e),
                      }),
                    )
                }
              >
                {t("Settings.Sync.Now")}
              </Button>
            </Group>
          )}
          <Button leftSection={<IconPlus size="1rem" />} onClick={startCreate}>
            {t("Repertoires.New")}
          </Button>
        </Group>
      </Group>

      <Group px="lg" pb="md">
        <TextInput
          placeholder={t("Common.Search")}
          leftSection={<IconSearch size="1rem" />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          style={{ flex: 1, maxWidth: 360 }}
        />
        <SegmentedControl
          value={color}
          onChange={(v) => setColor(v as typeof color)}
          data={[
            { label: t("Repertoires.All"), value: "all" },
            { label: t("Common.WHITE"), value: "white" },
            { label: t("Common.BLACK"), value: "black" },
          ]}
        />
      </Group>

      <ScrollArea flex={1} px="lg" pb="lg">
        {isLoading ? (
          <Center h={200}>
            <Loader />
          </Center>
        ) : visible.length === 0 ? (
          <Center h={240}>
            <Stack align="center" gap="xs">
              <IconBook size={48} style={{ color: "var(--mantine-color-dimmed)" }} />
              <Text c="dimmed" ta="center" maw={420}>
                {files && files.length > 0 ? t("Repertoires.NoMatch") : t("Repertoires.Empty")}
              </Text>
              {(!files || files.length === 0) && (
                <Button mt="sm" leftSection={<IconPlus size="1rem" />} onClick={startCreate}>
                  {t("Repertoires.New")}
                </Button>
              )}
            </Stack>
          </Center>
        ) : (
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3, xl: 4 }} spacing="md">
            {visible.map((file) => (
              <RepertoireCard
                key={file.path}
                file={file}
                onOpen={openRepertoire}
                onRename={setRenaming}
                onDelete={setDeleting}
                onToDo={reportToDo}
              />
            ))}
          </SimpleGrid>
        )}
      </ScrollArea>

      <CreateRepertoireModal
        opened={createOpen}
        setOpened={setCreateOpen}
        dir={createDir}
        onCreated={() => mutate()}
      />
      {renaming && (
        <EditModal
          opened={renaming !== null}
          setOpened={(open) => {
            if (!open) setRenaming(null);
          }}
          mutate={() => mutate()}
          setSelected={() => {}}
          metadata={renaming}
        />
      )}
      <ConfirmModal
        title={t("Repertoires.DeleteTitle", { name: deleting?.name ?? "" })}
        description={
          deleting?.inSyncFolder ? t("Repertoires.DeleteSyncedDesc") : t("Repertoires.DeleteDesc")
        }
        opened={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && confirmDelete(deleting)}
      />
    </Stack>
  );
}
