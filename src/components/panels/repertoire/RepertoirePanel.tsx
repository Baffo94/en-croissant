import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconBookmarkPlus,
  IconCheck,
  IconExternalLink,
  IconInfoCircle,
  IconRefresh,
  IconSparkles,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useAtom, useAtomValue, useSetAtom, useStore as useJotaiStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import useSWRImmutable from "swr/immutable";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
  listRepertoires,
  openRepertoireTab,
  practiceLabel,
} from "@/components/repertoires/repertoireFiles";
import { activeTabAtom, currentTabAtom, tabsAtom } from "@/state/atoms";
import { getOpening } from "@/utils/chess";
import { getDocumentDir } from "@/utils/directories";
import { reloadTabs, tabIsDirty, tabsOfFiles } from "@/utils/reloadTabs";
import { applyOp, type RepertoireOp } from "@/utils/repertoireEdit";
import {
  buildIndex,
  type Color,
  lookup,
  type Occurrence,
  placeIn,
  type Reason,
  type RepFile,
  suggest,
} from "@/utils/repertoireLookup";
import {
  isConfigured,
  resolveSyncFolder,
  scheduleSync,
  syncConfigAtom,
  syncStatusAtom,
} from "@/utils/sync";
import { normalizePath } from "@/utils/sync/core";
import { getTabFile } from "@/utils/tabs";
import type { TreeNode } from "@/utils/treeReducer";

/** The repertoire you chose for an opening's name: proposed first next time. */
const learnedAtom = atomWithStorage<Record<string, string>>(
  "repertoire-placement-learned",
  {},
  undefined,
  {
    getOnInit: true,
  },
);
const allColorsAtom = atomWithStorage("repertoire-lookup-all-colors", false, undefined, {
  getOnInit: true,
});

/** "1.e4 c6 2.d4" (from the start of the game; `from` moves are already played). */
export function formatLine(sans: readonly string[], firstHalfMove = 0): string {
  return sans
    .map((san, i) => {
      const half = firstHalfMove + i;
      const n = Math.floor(half / 2) + 1;
      if (half % 2 === 0) return `${n}.${san}`;
      return i === 0 ? `${n}...${san}` : san;
    })
    .join(" ");
}

function lineOf(
  root: TreeNode,
  position: number[],
): { fens: string[]; sans: string[]; nodes: TreeNode[] } {
  const fens = [root.fen];
  const sans: string[] = [];
  const nodes = [root];
  let node = root;
  for (const i of position) {
    const child = node.children[i];
    if (!child?.san) break;
    node = child;
    nodes.push(node);
    fens.push(node.fen);
    sans.push(node.san as string);
  }
  return { fens, sans, nodes };
}

function useRepertoireIndex() {
  const syncConfig = useAtomValue(syncConfigAtom);
  const syncStatus = useAtomValue(syncStatusAtom);
  const { data: files, mutate: refreshFiles } = useSWR(
    ["lookup-repertoires", syncConfig.folder, isConfigured(syncConfig), syncStatus.lastSync],
    async () => {
      const documentDir = await getDocumentDir();
      const syncFolder = isConfigured(syncConfig) ? await resolveSyncFolder(syncConfig) : null;
      return listRepertoires(documentDir, syncFolder);
    },
    { revalidateOnFocus: true },
  );
  const { data: index, mutate: refreshIndex } = useSWR(
    files ? ["lookup-index", files.map((f) => `${f.path}:${f.lastModified}`).join("|")] : null,
    async () => {
      const sources = [];
      for (const f of files ?? []) {
        try {
          sources.push({
            path: f.path,
            label: practiceLabel(f),
            group: f.group,
            name: f.name,
            text: await readTextFile(f.path),
          });
        } catch {
          // An unreadable file is left out.
        }
      }
      return buildIndex(sources);
    },
  );
  return {
    files,
    index,
    refresh: async () => {
      await refreshFiles();
      await refreshIndex();
    },
  };
}

export default function RepertoirePanel() {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  const headers = useStore(store, (s) => s.headers);
  const currentTab = useAtomValue(currentTabAtom);
  const [allColors, setAllColors] = useAtom(allColorsAtom);
  const [learned, setLearned] = useAtom(learnedAtom);
  const [other, setOther] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { files, index, refresh } = useRepertoireIndex();

  const setTabs = useSetAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const jotai = useJotaiStore();
  const navigate = useNavigate();

  const line = useMemo(() => lineOf(root, position), [root, position]);
  const fen = line.fens[line.fens.length - 1];
  const color: Color = headers.orientation === "black" ? "black" : "white";
  const firstHalfMove = line.nodes[0].halfMoves;

  const { data: opening = "" } = useSWRImmutable(
    ["opening", root.fen, ...line.sans],
    () => getOpening(root, position),
    { keepPreviousData: true },
  );

  if (!index || !files) {
    return (
      <Group p="md">
        <Loader size="sm" />
      </Group>
    );
  }

  const filter = allColors ? null : color;
  const found = lookup(index, fen, filter);
  const suggestions =
    found.length > 0 ? [] : suggest(index, line, opening, filter, learned).slice(0, 3);
  const choosable = index.files.filter((f) => filter === null || f.orientation === filter);
  const otherFile = choosable.find((f) => f.path === other) ?? null;
  const otherPlace = otherFile ? placeIn(index, otherFile, line) : null;
  const metaOf = (path: string) => files.find((f) => f.path === path);

  async function open(o: { file: RepFile; game: number; line: string[] }) {
    const meta = metaOf(o.file.path);
    if (!meta) return;
    await openRepertoireTab(
      meta,
      { at: { game: o.game, line: o.line } },
      {
        setTabs,
        setActiveTab,
        store: jotai,
        navigate,
      },
    );
  }

  /** Applies an edit to a file on disk, refreshing its open tabs (refused if one has unsaved changes). */
  async function edit(file: RepFile, game: number, op: RepertoireOp) {
    const target = normalizePath(file.path);
    const tabs = tabsOfFiles((p) => normalizePath(p) === target);
    if (tabs.some(tabIsDirty)) {
      const here = normalizePath(getTabFile(currentTab)?.path ?? "") === target;
      throw new Error(
        here ? t("Repertoires.Lookup.SaveThisTab") : t("Repertoires.Lookup.SaveFirst"),
      );
    }
    const text = await readTextFile(file.path);
    const result = applyOp(text, game, op);
    if (result.changed) {
      await writeTextFile(file.path, result.text);
      await reloadTabs(tabs);
      scheduleSync(3000, file.path);
      await refresh();
    }
    return result;
  }

  async function add(file: RepFile, game: number, addLine: string[], missing: string[]) {
    setBusy(true);
    try {
      const result = await edit(file, game, { kind: "add", line: addLine });
      if (opening) setLearned((l) => ({ ...l, [opening]: file.path }));
      setOther(null);
      if (!result.changed) return;
      const id = `lookup-add-${file.path}-${addLine.length}`;
      const undo = async () => {
        notifications.hide(id);
        try {
          if (result.inverse) await edit(file, game, result.inverse);
          notifications.show({ message: t("Repertoires.Lookup.Undone") });
        } catch (e) {
          notifications.show({ color: "red", message: e instanceof Error ? e.message : String(e) });
        }
      };
      notifications.show({
        id,
        color: "green",
        autoClose: 10_000,
        title: t("Repertoires.Lookup.Added", { file: file.label }),
        message: (
          <Group justify="space-between" gap="xs" wrap="nowrap">
            <Text size="sm">
              {formatLine(missing, firstHalfMove + addLine.length - missing.length)}
            </Text>
            <Button size="compact-xs" variant="light" onClick={undo}>
              {t("Repertoires.Lookup.Undo")}
            </Button>
          </Group>
        ),
      });
    } catch (e) {
      notifications.show({ color: "orange", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const reasonText = (r: Reason) =>
    r.kind === "learned"
      ? t("Repertoires.Lookup.ReasonLearned")
      : r.kind === "shared"
        ? t("Repertoires.Lookup.ReasonShared", {
            line: formatLine(
              r.after.slice(-3),
              firstHalfMove + r.after.length - Math.min(3, r.after.length),
            ),
            count: r.plies,
          })
        : t("Repertoires.Lookup.ReasonName", { words: r.words.join(", ") });

  return (
    <ScrollArea h="100%" offsetScrollbars>
      <Stack p="sm" gap="sm">
        <Group justify="space-between" wrap="nowrap">
          <Text size="sm" c="dimmed" lineClamp={2}>
            {opening || t("Repertoires.Lookup.NoName")}
          </Text>
          <Group gap="xs" wrap="nowrap">
            <Switch
              size="xs"
              checked={allColors}
              onChange={(e) => setAllColors(e.currentTarget.checked)}
              label={t("Repertoires.Lookup.AllColors")}
            />
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={refresh}
              aria-label={t("Repertoires.Lookup.Refresh")}
            >
              <IconRefresh size="0.9rem" />
            </Button>
          </Group>
        </Group>

        {found.length > 0 ? (
          <>
            <Alert color="green" icon={<IconCheck size="1rem" />} p="xs">
              {t("Repertoires.Lookup.Found", { count: found.length })}
            </Alert>
            {found.map((o) => (
              <FoundCard
                key={`${o.file.path}#${o.game}`}
                o={o}
                sameLine={o.line.join(" ") === line.sans.join(" ")}
                showColor={allColors}
                firstHalfMove={firstHalfMove}
                onOpen={() => open(o)}
              />
            ))}
          </>
        ) : (
          <>
            <Alert color="blue" icon={<IconSparkles size="1rem" />} p="xs">
              {t(
                color === "white" && !allColors
                  ? "Repertoires.Lookup.NewWhite"
                  : color === "black" && !allColors
                    ? "Repertoires.Lookup.NewBlack"
                    : "Repertoires.Lookup.New",
              )}
            </Alert>
            {line.sans.length === 0 ? null : suggestions.length === 0 ? (
              <Text size="sm" c="dimmed">
                {t("Repertoires.Lookup.NoSuggestion")}
              </Text>
            ) : (
              <Text size="sm" fw={600}>
                {t("Repertoires.Lookup.Suggested")}
              </Text>
            )}
            {line.sans.length > 0 &&
              suggestions.map((s, i) => (
                <Card key={s.file.path} withBorder p="xs">
                  <Group justify="space-between" wrap="nowrap" align="flex-start">
                    <Stack gap={2}>
                      <Group gap={6}>
                        <Text fw={600} size="sm">
                          {s.file.label}
                        </Text>
                        {i === 0 && (
                          <Badge size="xs" variant="light">
                            {t("Repertoires.Lookup.Best")}
                          </Badge>
                        )}
                      </Group>
                      {s.reasons.map((r) => (
                        <Text key={r.kind} size="xs" c="dimmed">
                          {reasonText(r)}
                        </Text>
                      ))}
                      {s.addLine && (
                        <Text size="xs">
                          {t("Repertoires.Lookup.WillAdd", {
                            moves: formatLine(
                              s.missing,
                              firstHalfMove + s.addLine.length - s.missing.length,
                            ),
                          })}
                        </Text>
                      )}
                    </Stack>
                    <Stack gap={4}>
                      <Button
                        size="compact-sm"
                        leftSection={<IconBookmarkPlus size="0.9rem" />}
                        disabled={!s.addLine || busy}
                        onClick={() => s.addLine && add(s.file, s.game, s.addLine, s.missing)}
                      >
                        {t("Repertoires.Lookup.AddHere")}
                      </Button>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        leftSection={<IconExternalLink size="0.8rem" />}
                        onClick={() =>
                          open({
                            file: s.file,
                            game: s.game,
                            line: s.addLine
                              ? s.addLine.slice(0, s.addLine.length - s.missing.length)
                              : [],
                          })
                        }
                      >
                        {t("Repertoires.Lookup.Open")}
                      </Button>
                    </Stack>
                  </Group>
                </Card>
              ))}
            {line.sans.length > 0 && (
              <Card withBorder p="xs">
                <Text size="sm" fw={600} mb={4}>
                  {t("Repertoires.Lookup.Elsewhere")}
                </Text>
                <Group gap="xs" wrap="nowrap" align="flex-end">
                  <Select
                    flex={1}
                    size="xs"
                    searchable
                    placeholder={t("Repertoires.Lookup.ChooseFile")}
                    data={choosable.map((f) => ({ value: f.path, label: f.label }))}
                    value={other}
                    onChange={setOther}
                  />
                  <Button
                    size="xs"
                    disabled={!otherFile || !otherPlace || busy}
                    onClick={() =>
                      otherFile &&
                      otherPlace &&
                      add(otherFile, otherPlace.game, otherPlace.addLine, otherPlace.missing)
                    }
                  >
                    {t("Repertoires.Lookup.AddHere")}
                  </Button>
                </Group>
                {otherFile && !otherPlace && (
                  <Text size="xs" c="orange" mt={4}>
                    {t("Repertoires.Lookup.CannotAdd")}
                  </Text>
                )}
                {otherFile && otherPlace && (
                  <Text size="xs" mt={4}>
                    {t("Repertoires.Lookup.WillAdd", {
                      moves: formatLine(
                        otherPlace.missing,
                        firstHalfMove + otherPlace.addLine.length - otherPlace.missing.length,
                      ),
                    })}
                  </Text>
                )}
              </Card>
            )}
            <Group gap={6} wrap="nowrap">
              <IconInfoCircle size="0.9rem" style={{ flexShrink: 0 }} />
              <Text size="xs" c="dimmed">
                {t("Repertoires.Lookup.AddNote")}
              </Text>
            </Group>
          </>
        )}
      </Stack>
    </ScrollArea>
  );
}

function FoundCard({
  o,
  sameLine,
  showColor,
  firstHalfMove,
  onOpen,
}: {
  o: Occurrence;
  sameLine: boolean;
  showColor: boolean;
  firstHalfMove: number;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card withBorder p="xs">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Stack gap={2}>
          <Group gap={6}>
            <Text fw={600} size="sm">
              {o.file.label}
            </Text>
            {showColor && (
              <Badge size="xs" variant="outline" color="gray">
                {t(o.file.orientation === "white" ? "Repertoires.White" : "Repertoires.Black")}
              </Badge>
            )}
          </Group>
          {!sameLine && (
            <Text size="xs" c="orange">
              {t("Repertoires.Lookup.Transposition", { line: formatLine(o.line, firstHalfMove) })}
            </Text>
          )}
          <Text size="xs">
            {o.moves.length === 0
              ? t("Repertoires.Lookup.EndOfLine")
              : o.yours
                ? t("Repertoires.Lookup.YourMove", { move: o.moves[0] }) +
                  (o.moves.length > 1
                    ? ` ${t("Repertoires.Lookup.AlsoMoves", { moves: o.moves.slice(1).join(", ") })}`
                    : "")
                : t("Repertoires.Lookup.Replies", { moves: o.moves.join(", ") })}
          </Text>
        </Stack>
        <Button
          size="compact-sm"
          variant="light"
          leftSection={<IconExternalLink size="0.9rem" />}
          onClick={onOpen}
        >
          {t("Repertoires.Lookup.Open")}
        </Button>
      </Group>
    </Card>
  );
}
