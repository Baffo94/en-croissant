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
  Tabs,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconArrowsSplit,
  IconChess,
  IconBook,
  IconBulb,
  IconChevronDown,
  IconChevronUp,
  IconCloud,
  IconCloudCheck,
  IconDots,
  IconFlag,
  IconFolder,
  IconFolderOpen,
  IconFolderSymlink,
  IconPencil,
  IconPlayerPause,
  IconPlayerPlay,
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
import { atom, useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { useEffect, useMemo, useState } from "react";
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
  practiceSessionStatsFamily,
  tabFamily,
  tabsAtom,
} from "@/state/atoms";
import { parsePGN } from "@/utils/chess";
import { ideaPoints } from "@/utils/ideas";
import { getMoveComment } from "@/utils/pgnEdit";
import {
  decksOfFile,
  isRepertoirePaused,
  pauseAtomOf,
  removeDecks,
  setPaused,
} from "@/utils/practiceDecks";
import {
  isConfigured,
  resolveSyncFolder,
  scheduleSync,
  syncConfigAtom,
  syncNow,
  syncStatusAtom,
} from "@/utils/sync";
import { normalizePath, relativePath } from "@/utils/sync/core";
import { createTab } from "@/utils/tabs";
import { prepareMixedSession } from "@/utils/trainAll";
import { unwrap } from "@/utils/unwrap";
import { CheckPanel, useOpenIssues } from "./CheckPanel";
import { GamesPanel } from "./GamesPanel";
import { FlagsPanel, useAllFlags } from "./FlagsPanel";
import { IdeasModal } from "./IdeasModal";
import { type CheckFile, checkRunAtom, startCheck } from "./checkRunner";
import {
  type GroupChoice,
  MoveToGroupModal,
  RenameGroupModal,
  removeIfEmpty,
  SplitModal,
} from "./GroupModals";
import {
  type CardStats,
  dirName,
  emptyStats,
  groupFiles,
  groupOf,
  type Listed,
  sumStats,
} from "./groups";

dayjs.extend(relativeTime);

/** Sync shortly after pausing/resuming, so the phone sees it. */
const PAUSE_SYNC_DELAY = 5_000;

type RepertoireFile = FileMetadata & {
  inSyncFolder: boolean;
  folder: string;
  /** Repertoires folder the file belongs to (sync folder or documents). */
  base: string;
  /** Group (subfolder of `base`) the file is a section of; "" for none. */
  group: string;
};

type Info = { orientation: "white" | "black"; positions: number; ideas: number };

type FileState = { stats: CardStats; paused: boolean; toDo: number };

/** Name shown while practising: "Group · Section" for a section of a group. */
function practiceLabel(file: RepertoireFile): string {
  return file.group ? `${file.group.split("/").pop()} · ${file.name}` : file.name;
}

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
      const inSyncFolder = syncFolder !== null && relativePath(syncFolder, file.path) !== null;
      const base = inSyncFolder && syncFolder ? syncFolder : root;
      files.push({ ...file, folder, inSyncFolder, base, group: groupOf(base, file.path) });
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/** Orientation and positions of the first game of each file, parsed from the PGN. */
async function readInfos(files: RepertoireFile[]): Promise<Record<string, Info>> {
  const result: Record<string, Info> = {};
  for (const file of files) {
    try {
      const pgn = unwrap(await commands.readGames(file.path, 0, 0))[0] ?? "";
      const tree = await parsePGN(pgn);
      const orientation = tree.headers.orientation === "black" ? "black" : "white";
      const positions = buildFromTree(tree.root, orientation, tree.headers.start ?? []);
      result[file.path] = {
        orientation,
        positions: positions.length,
        ideas: ideaPoints(getMoveComment(pgn, 0, [])).length,
      };
    } catch {
      result[file.path] = { orientation: "white", positions: 0, ideas: 0 };
    }
  }
  return result;
}

/** Changes every minute, so that positions becoming due show up without a refresh. */
function useMinuteTick() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  return tick;
}

function cardStats(decks: Record<number, PracticeData>, fallbackTotal: number): CardStats {
  const all = Object.values(decks);
  const positions = all.flatMap((d) => d.positions);
  if (positions.length === 0) {
    return { ...emptyStats(), total: fallbackTotal, unseen: fallbackTotal };
  }
  const stats = getStats(
    positions,
    all.flatMap((d) => d.logs),
  );
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

function fileState(file: RepertoireFile, info: Info | undefined): FileState {
  // Only the games that still exist in the PGN: decks left behind by deleted games
  // would otherwise count positions that can never be practised.
  const decks = Object.fromEntries(
    Object.entries(decksOfFile(file.path)).filter(([game]) => Number(game) < (file.numGames || 1)),
  );
  const stats = cardStats(decks, info?.positions ?? 0);
  const paused = isRepertoirePaused(file.path);
  return { stats, paused, toDo: paused ? 0 : stats.due + stats.unseen };
}

function useFromNow() {
  const { i18n } = useTranslation();
  return (date: Date) =>
    dayjs(date)
      .locale(i18n.language?.slice(0, 2) === "it" ? "it" : "en")
      .fromNow();
}

function ColorDot({ orientation, size = 18 }: { orientation?: "white" | "black"; size?: number }) {
  return (
    <Box
      w={size}
      h={size}
      style={{
        flexShrink: 0,
        borderRadius: "50%",
        border: "2px solid var(--mantine-color-gray-5)",
        background: orientation === "black" ? "#000" : "#fff",
      }}
    />
  );
}

/** Progress ring, badges and dates: shared by repertoire and group cards. */
function StatsBody({ stats, paused, toDo }: FileState) {
  const { t } = useTranslation();
  const fromNow = useFromNow();
  const pct = (n: number) => (stats.total > 0 ? (n / stats.total) * 100 : 0);
  const mastery = Math.round(pct(stats.learned));
  return (
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
        <StatusBadges stats={stats} paused={paused} toDo={toDo} />
        <Text size="xs" c="dimmed">
          {t("Repertoires.Positions", { count: stats.total })}
        </Text>
        <Text size="xs" c="dimmed">
          {stats.lastReview
            ? t("Repertoires.LastPractice", { when: fromNow(stats.lastReview) })
            : t("Repertoires.NeverPracticed")}
        </Text>
        {!paused && toDo === 0 && stats.nextDue && (
          <Text size="xs" c="dimmed">
            {t("Repertoires.NextReview", { when: fromNow(stats.nextDue) })}
          </Text>
        )}
      </Stack>
    </Group>
  );
}

function StatusBadges({ stats, paused, toDo, size }: FileState & { size?: "xs" | "sm" }) {
  const { t } = useTranslation();
  return (
    <Group gap={6} wrap="nowrap">
      {paused && (
        <Badge
          size={size}
          color="gray"
          variant="filled"
          leftSection={<IconPlayerPause size="0.7rem" />}
        >
          {t("Repertoires.Paused")}
        </Badge>
      )}
      {!paused && stats.due > 0 && (
        <Badge size={size} color="orange" variant="light">
          {t("Repertoires.Due", { count: stats.due })}
        </Badge>
      )}
      {!paused && stats.unseen > 0 && (
        <Badge size={size} color="blue" variant="light">
          {t("Repertoires.NewPositions", { count: stats.unseen })}
        </Badge>
      )}
      {!paused && toDo === 0 && stats.total > 0 && (
        <Badge size={size} color="teal" variant="light">
          {t("Repertoires.UpToDate")}
        </Badge>
      )}
    </Group>
  );
}

type FileActions = {
  onOpen: (file: RepertoireFile, practice: boolean) => void;
  onTogglePause: (file: RepertoireFile) => void;
  onRename: (file: RepertoireFile) => void;
  onMoveToGroup: (file: RepertoireFile) => void;
  onSplit: (file: RepertoireFile) => void;
  onDelete: (file: RepertoireFile) => void;
  onCheck: (file: RepertoireFile) => void;
  onIdeas: (file: RepertoireFile) => void;
  /** Open moves flagged to review in a file, and what to do on click. */
  flagsOf: (file: RepertoireFile) => number;
  onFlags: () => void;
};

/** Red flag with the number of moves to review (shown only when there are some). */
function FlagsButton({ file, actions }: { file: RepertoireFile; actions: FileActions }) {
  const { t } = useTranslation();
  const count = actions.flagsOf(file);
  if (!count) return null;
  const label = t("Repertoires.Flags.Count", { count });
  return (
    <Tooltip label={label}>
      <ActionIcon variant="light" color="red" aria-label={label} onClick={actions.onFlags}>
        <IconFlag size="1rem" />
      </ActionIcon>
    </Tooltip>
  );
}

/** Button of a section's ideas: lit when the section has some. */
function IdeasButton({
  file,
  count,
  actions,
}: {
  file: RepertoireFile;
  count: number;
  actions: FileActions;
}) {
  const { t } = useTranslation();
  const label = count ? t("Repertoires.Ideas.Show", { count }) : t("Repertoires.Ideas.Add");
  return (
    <Tooltip label={label}>
      <ActionIcon
        variant={count ? "light" : "subtle"}
        color={count ? "yellow" : "gray"}
        aria-label={label}
        onClick={() => actions.onIdeas(file)}
      >
        <IconBulb size="1rem" />
      </ActionIcon>
    </Tooltip>
  );
}

function showInFolder(path: string) {
  openPath(path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))));
}

/** The "⋯" menu of a repertoire or of a section. */
function FileMenu({
  file,
  paused,
  actions,
}: {
  file: RepertoireFile;
  paused: boolean;
  actions: FileActions;
}) {
  const { t } = useTranslation();
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon variant="subtle" color="gray" aria-label={t("Repertoires.Actions")}>
          <IconDots size="1rem" />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          leftSection={<IconBook size="1rem" />}
          onClick={() => actions.onOpen(file, false)}
        >
          {t("Repertoires.Open")}
        </Menu.Item>
        <Menu.Item
          leftSection={paused ? <IconPlayerPlay size="1rem" /> : <IconPlayerPause size="1rem" />}
          onClick={() => actions.onTogglePause(file)}
        >
          {paused ? t("Repertoires.Resume") : t("Repertoires.Pause")}
        </Menu.Item>
        <Menu.Item leftSection={<IconPencil size="1rem" />} onClick={() => actions.onRename(file)}>
          {t("Repertoires.Rename")}
        </Menu.Item>
        <Menu.Item
          leftSection={<IconFolderSymlink size="1rem" />}
          onClick={() => actions.onMoveToGroup(file)}
        >
          {t("Repertoires.MoveToGroup")}
        </Menu.Item>
        {file.numGames > 1 && (
          <Menu.Item
            leftSection={<IconArrowsSplit size="1rem" />}
            onClick={() => actions.onSplit(file)}
          >
            {t("Repertoires.SplitSections")}
          </Menu.Item>
        )}
        <Menu.Item leftSection={<IconSearch size="1rem" />} onClick={() => actions.onCheck(file)}>
          {t("Repertoires.Check.Run")}
        </Menu.Item>
        <Menu.Item
          leftSection={<IconFolderOpen size="1rem" />}
          onClick={() => showInFolder(file.path)}
        >
          {t("Repertoires.ShowInFolder")}
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          color="red"
          leftSection={<IconTrash size="1rem" />}
          onClick={() => actions.onDelete(file)}
        >
          {t("Common.Delete")}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

function RepertoireCard({
  file,
  info,
  state,
  actions,
}: {
  file: RepertoireFile;
  info: Info | undefined;
  state: FileState;
  actions: FileActions;
}) {
  const { t } = useTranslation();
  const { paused, toDo } = state;

  return (
    <Card
      withBorder
      radius="md"
      padding="md"
      style={{ alignSelf: "start", opacity: paused ? 0.6 : undefined }}
    >
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <ColorDot orientation={info?.orientation} />
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
          <FlagsButton file={file} actions={actions} />
          <IdeasButton file={file} count={info?.ideas ?? 0} actions={actions} />
          <FileMenu file={file} paused={paused} actions={actions} />
        </Group>
      </Group>

      <StatsBody {...state} />

      <Group mt="md" grow>
        <Button
          leftSection={<IconTarget size="1rem" />}
          variant={toDo > 0 ? "filled" : "light"}
          onClick={() => actions.onOpen(file, true)}
        >
          {toDo > 0 ? t("Repertoires.Practice", { count: toDo }) : t("Repertoires.PracticeAnyway")}
        </Button>
        <Button
          variant="default"
          leftSection={<IconBook size="1rem" />}
          onClick={() => actions.onOpen(file, false)}
        >
          {t("Repertoires.Open")}
        </Button>
      </Group>
    </Card>
  );
}

type GroupEntry = Extract<Listed<RepertoireFile>, { kind: "group" }>;

type GroupActions = {
  onTrain: (group: GroupEntry) => void;
  onTogglePause: (group: GroupEntry, paused: boolean) => void;
  onAddSection: (group: GroupEntry, orientation: "white" | "black") => void;
  onRename: (group: GroupEntry) => void;
  onDelete: (group: GroupEntry) => void;
  onCheck: (group: GroupEntry) => void;
};

const EXPANDED_KEY = "repertoire-groups-expanded";

function useExpanded(key: string): [boolean, () => void] {
  const read = () => {
    try {
      return (JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]") as string[]).includes(key);
    } catch {
      return false;
    }
  };
  const [expanded, setExpanded] = useState(read);
  const toggle = () => {
    setExpanded((prev) => {
      try {
        const list = (JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]") as string[]).filter(
          (k) => k !== key,
        );
        if (!prev) list.push(key);
        localStorage.setItem(EXPANDED_KEY, JSON.stringify(list));
      } catch {
        // Remembering the open groups is only a convenience.
      }
      return !prev;
    });
  };
  return [expanded, toggle];
}

/** One section of a group, as a compact row inside the group card. */
function SectionRow({
  file,
  state,
  ideas,
  actions,
}: {
  file: RepertoireFile;
  state: FileState;
  ideas: number;
  actions: FileActions;
}) {
  const { t } = useTranslation();
  return (
    <Group
      wrap="nowrap"
      justify="space-between"
      gap="xs"
      py={6}
      px="xs"
      style={{
        borderRadius: "var(--mantine-radius-sm)",
        background: "var(--mantine-color-default-hover)",
        opacity: state.paused ? 0.6 : 1,
      }}
    >
      <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
        <Text size="sm" fw={500} truncate>
          {file.name}
          {file.numGames > 1 && (
            <Text span size="xs" c="dimmed">
              {` · ${t("Repertoires.Games", { count: file.numGames })}`}
            </Text>
          )}
        </Text>
        <StatusBadges {...state} size="xs" />
      </Stack>
      <Group gap={2} wrap="nowrap">
        <FlagsButton file={file} actions={actions} />
        <IdeasButton file={file} count={ideas} actions={actions} />
        <Tooltip
          label={
            state.toDo > 0
              ? t("Repertoires.Practice", { count: state.toDo })
              : t("Repertoires.PracticeAnyway")
          }
        >
          <ActionIcon
            variant={state.toDo > 0 ? "filled" : "subtle"}
            color={state.toDo > 0 ? undefined : "gray"}
            aria-label={t("Repertoires.Practice", { count: state.toDo })}
            onClick={() => actions.onOpen(file, true)}
          >
            <IconTarget size="1rem" />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t("Repertoires.Open")}>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={t("Repertoires.Open")}
            onClick={() => actions.onOpen(file, false)}
          >
            <IconBook size="1rem" />
          </ActionIcon>
        </Tooltip>
        <FileMenu file={file} paused={state.paused} actions={actions} />
      </Group>
    </Group>
  );
}

function GroupCard({
  group,
  infos,
  states,
  fileActions,
  actions,
  training,
}: {
  group: GroupEntry;
  infos: Record<string, Info> | undefined;
  states: Record<string, FileState>;
  fileActions: FileActions;
  actions: GroupActions;
  training: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, toggle] = useExpanded(group.key);
  const sectionStates = group.files.map((f) => states[f.path]).filter(Boolean);
  const allPaused = sectionStates.length > 0 && sectionStates.every((s) => s.paused);
  const active = sectionStates.filter((s) => !s.paused);
  // A paused group shows the progress of all its sections; otherwise only the active ones count.
  const stats = sumStats((allPaused ? sectionStates : active).map((s) => s.stats));
  const toDo = active.reduce((n, s) => n + s.toDo, 0);
  const orientation = infos?.[group.files[0].path]?.orientation;
  const synced = group.files.some((f) => f.inSyncFolder);

  return (
    <Card
      withBorder
      radius="md"
      padding="md"
      // Cards keep their own height: an open group does not stretch its neighbours.
      style={{ alignSelf: "start", opacity: allPaused ? 0.6 : undefined }}
    >
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <UnstyledButton onClick={toggle} style={{ minWidth: 0, flex: 1 }}>
          <Group gap="sm" wrap="nowrap">
            <ColorDot orientation={orientation} />
            <div style={{ minWidth: 0 }}>
              <Group gap={6} wrap="nowrap">
                <IconFolder size="1rem" style={{ flexShrink: 0 }} />
                <Text fw={600} truncate>
                  {group.name}
                </Text>
              </Group>
              <Text size="xs" c="dimmed" truncate>
                {orientation === "black" ? t("Common.BLACK") : t("Common.WHITE")}
                {` · ${t("Repertoires.Sections", { count: group.files.length })}`}
              </Text>
            </div>
          </Group>
        </UnstyledButton>
        <Group gap={4} wrap="nowrap">
          {synced && (
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
              <Menu.Item
                leftSection={<IconTarget size="1rem" />}
                disabled={toDo === 0}
                onClick={() => actions.onTrain(group)}
              >
                {t("Repertoires.TrainGroup")}
              </Menu.Item>
              <Menu.Item
                leftSection={
                  allPaused ? <IconPlayerPlay size="1rem" /> : <IconPlayerPause size="1rem" />
                }
                onClick={() => actions.onTogglePause(group, !allPaused)}
              >
                {allPaused ? t("Repertoires.ResumeGroup") : t("Repertoires.PauseGroup")}
              </Menu.Item>
              <Menu.Item
                leftSection={<IconPlus size="1rem" />}
                onClick={() => actions.onAddSection(group, orientation ?? "white")}
              >
                {t("Repertoires.AddSection")}
              </Menu.Item>
              <Menu.Item
                leftSection={<IconSearch size="1rem" />}
                onClick={() => actions.onCheck(group)}
              >
                {t("Repertoires.Check.RunGroup")}
              </Menu.Item>
              <Menu.Item
                leftSection={<IconPencil size="1rem" />}
                onClick={() => actions.onRename(group)}
              >
                {t("Repertoires.RenameGroup")}
              </Menu.Item>
              <Menu.Item
                leftSection={<IconFolderOpen size="1rem" />}
                onClick={() => openPath(group.dir)}
              >
                {t("Repertoires.ShowInFolder")}
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item
                color="red"
                leftSection={<IconTrash size="1rem" />}
                onClick={() => actions.onDelete(group)}
              >
                {t("Repertoires.DeleteGroup")}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>

      <StatsBody stats={stats} paused={allPaused} toDo={toDo} />

      <Group mt="md" grow>
        <Button
          leftSection={<IconTarget size="1rem" />}
          variant={toDo > 0 ? "filled" : "light"}
          disabled={allPaused}
          loading={training}
          onClick={() => actions.onTrain(group)}
        >
          {toDo > 0 ? t("Repertoires.Practice", { count: toDo }) : t("Repertoires.TrainGroup")}
        </Button>
        <Button
          variant="default"
          leftSection={expanded ? <IconChevronUp size="1rem" /> : <IconChevronDown size="1rem" />}
          onClick={toggle}
        >
          {expanded
            ? t("Repertoires.HideSections")
            : t("Repertoires.Sections", { count: group.files.length })}
        </Button>
      </Group>

      {expanded && (
        <Stack gap={6} mt="md">
          {group.files.map((file) => (
            <SectionRow
              key={file.path}
              file={file}
              state={states[file.path] ?? fileState(file, infos?.[file.path])}
              ideas={infos?.[file.path]?.ideas ?? 0}
              actions={fileActions}
            />
          ))}
          <Button
            variant="subtle"
            size="xs"
            leftSection={<IconPlus size="0.9rem" />}
            onClick={() => actions.onAddSection(group, orientation ?? "white")}
          >
            {t("Repertoires.AddSection")}
          </Button>
        </Stack>
      )}
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
  const [create, setCreate] = useState<{
    dir: string;
    color?: "white" | "black";
    title?: string;
  } | null>(null);
  const [renaming, setRenaming] = useState<RepertoireFile | null>(null);
  const [deleting, setDeleting] = useState<RepertoireFile | null>(null);
  const [moving, setMoving] = useState<RepertoireFile | null>(null);
  const [splitting, setSplitting] = useState<RepertoireFile | null>(null);
  const [ideasFor, setIdeasFor] = useState<RepertoireFile | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<GroupEntry | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<GroupEntry | null>(null);
  const [view, setView] = useState<"list" | "check" | "games" | "flags">("list");
  const checkRun = useAtomValue(checkRunAtom);
  const issuesOf = useOpenIssues();
  /** "all" for Train all, a group key for a group, null when nothing is starting. */
  const [startingTrain, setStartingTrain] = useState<string | null>(null);

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

  // Bumped when ideas are saved here (the file's date may not change within a second).
  const [infosVersion, setInfosVersion] = useState(0);
  const { data: infos } = useSWR(
    files
      ? [
          "repertoire-infos",
          files.map((f) => `${f.path}:${f.lastModified}`).join("|"),
          infosVersion,
        ]
      : null,
    () => readInfos(files ?? []),
  );

  // Re-render when practice progress or pauses change (here, in a tab or by a sync).
  const watched = useMemo(
    () =>
      atom((get) => [
        ...(files ?? []).map((f) => get(deckAtomFamily({ file: f.path, game: 0 }))),
        ...(files ?? []).map((f) => get(pauseAtomOf(f.path))),
      ]),
    [files],
  );
  const watchedValues = useAtomValue(watched);
  const tick = useMinuteTick();

  const states = useMemo(() => {
    const result: Record<string, FileState> = {};
    for (const file of files ?? []) result[file.path] = fileState(file, infos?.[file.path]);
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, infos, watchedValues, tick]);

  const orientationOf = (file: RepertoireFile) => infos?.[file.path]?.orientation ?? "white";

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const list = (files ?? []).filter(
      (f) =>
        (!query ||
          f.name.toLowerCase().includes(query) ||
          f.folder.toLowerCase().includes(query)) &&
        (color === "all" || orientationOf(f) === color),
    );
    const isPaused = (l: Listed<RepertoireFile>) =>
      l.kind === "file"
        ? (states[l.file.path]?.paused ?? false)
        : l.files.every((f) => states[f.path]?.paused);
    // Paused repertoires and groups go to the end of the list.
    return groupFiles(list).sort((a, b) => Number(isPaused(a)) - Number(isPaused(b)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, search, color, infos, states]);

  const groups: GroupChoice[] = useMemo(
    () =>
      groupFiles(files ?? []).flatMap((l) =>
        l.kind === "group"
          ? [{ name: l.name, dir: l.dir, orientation: orientationOf(l.files[0]) }]
          : [],
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, infos],
  );

  const totalToDo = Object.values(states).reduce((n, s) => n + s.toDo, 0);

  const openIssues = (files ?? []).reduce((n, f) => n + issuesOf(f.path), 0);

  // Repertoires as the check sees them: answers are compared inside a group only.
  const flagFiles = useMemo(
    () => (files ?? []).map((f) => ({ path: f.path, label: practiceLabel(f) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files],
  );
  const allFlags = useAllFlags(flagFiles);
  const openFlagsOf = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const { file, flag } of allFlags)
      if (!flag.resolvedAt) counts[file.path] = (counts[file.path] ?? 0) + 1;
    return counts;
  }, [allFlags]);
  const openFlagCount = Object.values(openFlagsOf).reduce((a, b) => a + b, 0);

  const checkFiles: CheckFile[] = useMemo(
    () =>
      (files ?? []).map((f) => ({
        path: f.path,
        label: practiceLabel(f),
        group: f.group ? `${f.base}/${f.group}` : f.path,
      })),
    [files],
  );

  async function openRepertoire(
    file: RepertoireFile,
    practice: boolean,
    at?: { game: number; line: string[] },
  ) {
    const game = at?.game ?? 0;
    const [pgnResult, countResult] = await Promise.all([
      commands.readGames(file.path, game, game),
      commands.countPgnGames(file.path),
    ]);
    const pgn = unwrap(pgnResult)[0] ?? "";
    // Opened on a given position (from the repertoire check): path of child indices.
    let position: {
      headers: Awaited<ReturnType<typeof parsePGN>>["headers"];
      path: number[];
    } | null = null;
    if (at) {
      const tree = await parsePGN(pgn);
      const path: number[] = [];
      let node = tree.root;
      for (const san of at.line) {
        const i = node.children.findIndex((c) => c.san === san);
        if (i < 0) break;
        path.push(i);
        node = node.children[i];
      }
      position = { headers: tree.headers, path };
    }
    const tabId = await createTab({
      tab: { name: practiceLabel(file), type: "analysis" },
      setTabs,
      setActiveTab,
      pgn,
      ...(position ? { headers: position.headers, position: position.path } : {}),
      gameOrigin: {
        kind: "file",
        gameNumber: game,
        file: { ...file, numGames: unwrap(countResult) },
      },
    });
    if (practice) store.set(tabFamily(tabId), "practice");
    store.set(addRecentFileAtom, { name: file.name, path: file.path, type: "repertoire" });
    navigate({ to: "/" });
    return tabId;
  }

  /** Opens a practice tab that mixes the due positions of the given repertoires. */
  async function startMixed(list: RepertoireFile[], key: string, group?: string) {
    if (list.length === 0) return;
    setStartingTrain(key);
    try {
      const mixedFiles = list
        .filter((f) => !isRepertoirePaused(f.path))
        .map((f) => ({ path: f.path, name: practiceLabel(f) }));
      const queue = await prepareMixedSession(mixedFiles);
      const first = queue[0] && list.find((f) => f.path === queue[0].path);
      if (!first) {
        notifications.show({
          color: "green",
          title: t("Board.Practice.TrainAll"),
          message: t("Repertoires.AllDone"),
        });
        return;
      }
      const tabId = await openRepertoire(first, true);
      store.set(practiceSessionStatsFamily(tabId), {
        mode: "mixed",
        remainingPositions: [],
        mixedQueue: queue,
        mixedFiles,
        mixedGroup: group,
        mixedDone: false,
        correct: 0,
        incorrect: 0,
        streak: 0,
        bestStreak: 0,
      });
    } finally {
      setStartingTrain(null);
    }
  }

  async function startCreate() {
    let dir = documentDir;
    if (syncEnabled && syncFolder) {
      if (!(await exists(syncFolder))) await mkdir(syncFolder, { recursive: true });
      dir = syncFolder;
    }
    setCreate({ dir });
  }

  function togglePause(file: RepertoireFile) {
    setPaused(file.path, !isRepertoirePaused(file.path));
    // Let the other devices know (sync folder only).
    scheduleSync(PAUSE_SYNC_DELAY, file.path);
  }

  function toggleGroupPause(group: GroupEntry, paused: boolean) {
    for (const file of group.files) {
      if (isRepertoirePaused(file.path) !== paused) setPaused(file.path, paused);
    }
    scheduleSync(PAUSE_SYNC_DELAY, group.files[0].path);
  }

  async function deleteFile(file: RepertoireFile) {
    await remove(file.path);
    const info = file.path.replace(/\.pgn$/i, ".info");
    if (await exists(info)) await remove(info);
    removeDecks(file.path);
  }

  async function confirmDelete(file: RepertoireFile) {
    try {
      await deleteFile(file);
      if (file.group) await removeIfEmpty(dirName(file.path), file.base);
    } catch (e) {
      notifications.show({ color: "red", title: t("Common.Error"), message: String(e) });
    }
    setDeleting(null);
    mutate();
  }

  async function confirmDeleteGroup(group: GroupEntry) {
    try {
      for (const file of group.files) await deleteFile(file);
      await removeIfEmpty(group.dir, group.files[0].base);
    } catch (e) {
      notifications.show({ color: "red", title: t("Common.Error"), message: String(e) });
    }
    setDeletingGroup(null);
    mutate();
  }

  const fileActions: FileActions = {
    onOpen: openRepertoire,
    onTogglePause: togglePause,
    onRename: setRenaming,
    onMoveToGroup: setMoving,
    onSplit: setSplitting,
    onDelete: setDeleting,
    onCheck: (file) => {
      setView("check");
      startCheck(checkFiles, [file.path], practiceLabel(file));
    },
    onIdeas: setIdeasFor,
    flagsOf: (file) => openFlagsOf[file.path] ?? 0,
    onFlags: () => setView("flags"),
  };

  const groupActions: GroupActions = {
    onTrain: (group) => startMixed(group.files, group.key, group.name),
    onTogglePause: toggleGroupPause,
    onAddSection: (group, orientation) =>
      setCreate({
        dir: group.dir,
        color: orientation,
        title: t("Repertoires.AddSectionTitle", { group: group.name }),
      }),
    onRename: setRenamingGroup,
    onDelete: setDeletingGroup,
    onCheck: (group) => {
      setView("check");
      startCheck(
        checkFiles,
        group.files.map((f) => f.path),
        group.name,
      );
    },
  };

  return (
    <Stack h="100%" gap={0}>
      <Group px="lg" pt="lg" pb="sm" justify="space-between" align="flex-end">
        <div>
          <Title order={2}>{t("Repertoires.Title")}</Title>
          <Text c="dimmed" size="sm">
            {files && files.length > 0
              ? totalToDo > 0
                ? t("Repertoires.Summary", { count: totalToDo })
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
          {totalToDo > 0 && (
            <Button
              color="orange"
              leftSection={<IconTarget size="1rem" />}
              loading={startingTrain === "all"}
              onClick={() => startMixed(files ?? [], "all")}
            >
              {t("Repertoires.TrainAll", { count: totalToDo })}
            </Button>
          )}
          <Button leftSection={<IconPlus size="1rem" />} onClick={startCreate}>
            {t("Repertoires.New")}
          </Button>
        </Group>
      </Group>

      <Tabs value={view} onChange={(v) => setView((v as typeof view) ?? "list")} px="lg" pb="sm">
        <Tabs.List>
          <Tabs.Tab value="list" leftSection={<IconBook size="1rem" />}>
            {t("Repertoires.Tab.List")}
          </Tabs.Tab>
          <Tabs.Tab
            value="check"
            leftSection={<IconSearch size="1rem" />}
            rightSection={
              checkRun.running ? (
                <Loader size={12} />
              ) : openIssues > 0 ? (
                <Badge size="xs" color="orange" variant="light">
                  {openIssues}
                </Badge>
              ) : null
            }
          >
            {t("Repertoires.Tab.Check")}
          </Tabs.Tab>
          <Tabs.Tab value="games" leftSection={<IconChess size="1rem" />}>
            {t("Repertoires.Tab.Games")}
          </Tabs.Tab>
          <Tabs.Tab
            value="flags"
            leftSection={<IconFlag size="1rem" />}
            rightSection={
              openFlagCount > 0 ? (
                <Badge size="xs" color="red" variant="filled">
                  {openFlagCount}
                </Badge>
              ) : null
            }
          >
            {t("Repertoires.Tab.Flags")}
          </Tabs.Tab>
        </Tabs.List>
      </Tabs>

      {view === "flags" ? (
        <ScrollArea flex={1} px="lg" pb="lg">
          <FlagsPanel
            files={flagFiles}
            onOpen={(path, game, line) => {
              const file = files?.find((f) => f.path === path);
              if (file) openRepertoire(file, false, { game, line });
            }}
          />
        </ScrollArea>
      ) : view === "games" ? (
        <ScrollArea flex={1} px="lg" pb="lg">
          <GamesPanel
            files={checkFiles}
            onOpen={(path, game, line) => {
              const file = files?.find((f) => f.path === path);
              if (file) openRepertoire(file, false, { game, line });
            }}
          />
        </ScrollArea>
      ) : view === "check" ? (
        <ScrollArea flex={1} px="lg" pb="lg">
          <CheckPanel
            files={checkFiles}
            onOpen={(path, game, line) => {
              const file = files?.find((f) => f.path === path);
              if (file) openRepertoire(file, false, { game, line });
            }}
          />
        </ScrollArea>
      ) : (
        <>
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
                {visible.map((entry) =>
                  entry.kind === "file" ? (
                    <RepertoireCard
                      key={entry.file.path}
                      file={entry.file}
                      info={infos?.[entry.file.path]}
                      state={states[entry.file.path] ?? fileState(entry.file, undefined)}
                      actions={fileActions}
                    />
                  ) : (
                    <GroupCard
                      key={entry.key}
                      group={entry}
                      infos={infos}
                      states={states}
                      fileActions={fileActions}
                      actions={groupActions}
                      training={startingTrain === entry.key}
                    />
                  ),
                )}
              </SimpleGrid>
            )}
          </ScrollArea>
        </>
      )}

      <CreateRepertoireModal
        opened={create !== null}
        setOpened={(open) => {
          if (!open) setCreate(null);
        }}
        dir={create?.dir}
        fixedColor={create?.color}
        title={create?.title}
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
      <MoveToGroupModal
        file={moving}
        orientation={moving ? orientationOf(moving) : "white"}
        groups={groups}
        onClose={() => setMoving(null)}
        onDone={() => {
          setMoving(null);
          mutate();
        }}
      />
      <IdeasModal
        file={ideasFor}
        title={ideasFor ? practiceLabel(ideasFor) : ""}
        onClose={() => setIdeasFor(null)}
        onSaved={() => {
          setInfosVersion((v) => v + 1);
          mutate();
        }}
      />
      <SplitModal
        file={splitting}
        orientation={splitting ? orientationOf(splitting) : "white"}
        onClose={() => setSplitting(null)}
        onDone={() => {
          setSplitting(null);
          mutate();
        }}
      />
      <RenameGroupModal
        group={renamingGroup}
        onClose={() => setRenamingGroup(null)}
        onDone={() => {
          setRenamingGroup(null);
          mutate();
        }}
      />
      <ConfirmModal
        title={t("Repertoires.DeleteTitle", { name: deleting?.name ?? "" })}
        description={
          deleting?.inSyncFolder ? t("Repertoires.DeleteSyncedDesc") : t("Repertoires.DeleteDesc")
        }
        opened={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && confirmDelete(deleting)}
      />
      <ConfirmModal
        title={t("Repertoires.DeleteGroupTitle", { name: deletingGroup?.name ?? "" })}
        description={t("Repertoires.DeleteGroupDesc", { count: deletingGroup?.files.length ?? 0 })}
        opened={deletingGroup !== null}
        onClose={() => setDeletingGroup(null)}
        onConfirm={() => deletingGroup && confirmDeleteGroup(deletingGroup)}
      />
    </Stack>
  );
}
