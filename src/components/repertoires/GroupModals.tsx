import { Button, Group, Modal, Select, Stack, Text, TextInput } from "@mantine/core";
import { exists, mkdir, readDir, remove, rename } from "@tauri-apps/plugin-fs";
import { getDefaultStore } from "jotai";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import type { FileMetadata } from "@/components/files/file";
import { deckAtomFamily } from "@/state/atoms";
import { createFile } from "@/utils/files";
import {
  decksOfFile,
  isRepertoirePaused,
  moveDecks,
  removeDecks,
  setPaused,
} from "@/utils/practiceDecks";
import { scheduleSync } from "@/utils/sync";
import { unwrap } from "@/utils/unwrap";
import { dirName, joinPath, safeFileName } from "./groups";

/** Sync shortly after moving files, so the phone sees the new layout. */
const MOVE_SYNC_DELAY = 5_000;

export type GroupChoice = { name: string; dir: string; orientation: "white" | "black" };

type SectionFile = FileMetadata & { base: string; group: string };

async function moveRepertoire(from: string, to: string) {
  await rename(from, to);
  const info = from.replace(/\.pgn$/i, ".info");
  if (await exists(info)) await rename(info, to.replace(/\.pgn$/i, ".info"));
  moveDecks(from, to);
}

/** Removes a group folder left without files (e.g. after moving its last section). */
export async function removeIfEmpty(dir: string, base: string) {
  if (dir.replace(/[\\/]+$/, "") === base.replace(/[\\/]+$/, "")) return;
  try {
    if ((await readDir(dir)).length === 0) await remove(dir);
  } catch {
    // Not important: an empty folder simply shows nothing.
  }
}

const NONE = "__none__";
const NEW = "__new__";

/** "Move to group": puts a repertoire into a group (new or existing) or out of it. */
export function MoveToGroupModal({
  file,
  orientation,
  groups,
  onClose,
  onDone,
}: {
  file: SectionFile | null;
  orientation: "white" | "black";
  groups: GroupChoice[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<string>(NEW);
  const [groupName, setGroupName] = useState("");
  const [sectionName, setSectionName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const currentDir = file ? dirName(file.path) : "";
  // A group has a single colour: only groups of the same colour are offered.
  const options = groups.filter((g) => g.orientation === orientation && g.dir !== currentDir);

  useEffect(() => {
    if (!file) return;
    setChoice(options[0]?.dir ?? NEW);
    setGroupName(file.group ? "" : file.name);
    setSectionName(file.name);
    setError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  async function confirm() {
    if (!file) return;
    const section = safeFileName(sectionName);
    if (!section) return setError(t("Common.RequireName"));
    let dir: string;
    if (choice === NONE) dir = file.base;
    else if (choice === NEW) {
      const name = safeFileName(groupName);
      if (!name) return setError(t("Common.RequireName"));
      dir = joinPath(file.base, name);
    } else dir = choice;
    const target = joinPath(dir, `${section}.pgn`);
    if (target === file.path) return onClose();
    setBusy(true);
    try {
      if (await exists(target)) return setError(t("Repertoires.NameExists"));
      if (!(await exists(dir))) await mkdir(dir, { recursive: true });
      await moveRepertoire(file.path, target);
      await removeIfEmpty(currentDir, file.base);
      scheduleSync(MOVE_SYNC_DELAY, target);
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      opened={file !== null}
      onClose={onClose}
      title={t("Repertoires.MoveToGroupTitle", { name: file?.name ?? "" })}
    >
      <Stack>
        <Select
          label={t("Repertoires.Group")}
          value={choice}
          onChange={(v) => v && setChoice(v)}
          allowDeselect={false}
          data={[
            ...options.map((g) => ({ value: g.dir, label: g.name })),
            { value: NEW, label: t("Repertoires.NewGroup") },
            ...(file?.group ? [{ value: NONE, label: t("Repertoires.NoGroup") }] : []),
          ]}
        />
        {choice === NEW && (
          <TextInput
            label={t("Repertoires.GroupName")}
            value={groupName}
            onChange={(e) => setGroupName(e.currentTarget.value)}
            data-autofocus
          />
        )}
        <TextInput
          label={choice === NONE ? t("Common.Name") : t("Repertoires.SectionName")}
          value={sectionName}
          onChange={(e) => setSectionName(e.currentTarget.value)}
        />
        {error && (
          <Text c="red" size="sm">
            {error}
          </Text>
        )}
        <Group justify="right">
          <Button variant="default" onClick={onClose}>
            {t("Common.Cancel")}
          </Button>
          <Button loading={busy} onClick={confirm}>
            {t("Repertoires.Move")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function eventOf(pgn: string): string {
  const match = /\[Event "([^"]*)"\]/.exec(pgn);
  const event = match?.[1]?.trim() ?? "";
  return event && event !== "?" ? event : "";
}

/** Gives a game the repertoire's orientation when it does not state one itself. */
function withOrientation(pgn: string, orientation: "white" | "black"): string {
  if (/\[Orientation "/.test(pgn)) return pgn;
  return `[Orientation "${orientation}"]\n${pgn}`;
}

/**
 * "Split into sections": each game of a multi-game repertoire becomes a section (its
 * own file) of a group, keeping its practice progress. The original file is removed.
 */
export function SplitModal({
  file,
  orientation,
  onClose,
  onDone,
}: {
  file: (SectionFile & { numGames: number }) | null;
  orientation: "white" | "black";
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [games, setGames] = useState<string[]>([]);
  const [names, setNames] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Sections go into the file's group, or into a new group named after the file.
  const dir = file ? (file.group ? dirName(file.path) : joinPath(file.base, file.name)) : "";
  const groupName = file ? (file.group ? file.group.split("/").pop() : file.name) : "";

  useEffect(() => {
    if (!file) return;
    setError("");
    setGames([]);
    commands
      .readGames(file.path, 0, Math.max(0, file.numGames - 1))
      .then((result) => {
        const list = unwrap(result);
        setGames(list);
        setNames(
          list.map((pgn, i) => eventOf(pgn) || t("Repertoires.SectionDefault", { n: i + 1 })),
        );
      })
      .catch((e) => setError(String(e)));
  }, [file, t]);

  async function confirm() {
    if (!file) return;
    const cleaned = names.map(safeFileName);
    if (cleaned.some((n) => !n)) return setError(t("Common.RequireName"));
    if (new Set(cleaned.map((n) => n.toLowerCase())).size !== cleaned.length)
      return setError(t("Repertoires.DuplicateNames"));
    setBusy(true);
    try {
      for (const name of cleaned) {
        if (await exists(joinPath(dir, `${name}.pgn`)))
          return setError(`${t("Repertoires.NameExists")}: ${name}`);
      }
      if (!(await exists(dir))) await mkdir(dir, { recursive: true });
      const decks = decksOfFile(file.path);
      const paused = isRepertoirePaused(file.path);
      const store = getDefaultStore();
      for (const [i, pgn] of games.entries()) {
        const created = await createFile({
          filename: cleaned[i],
          filetype: "repertoire",
          pgn: withOrientation(pgn, orientation),
          dir,
        });
        if (created.isErr) throw created.error;
        const path = created.value.path;
        // The progress of game i becomes the progress of the new file.
        if (decks[i]) store.set(deckAtomFamily({ file: path, game: 0 }), decks[i]);
        if (paused) setPaused(path, true);
      }
      await remove(file.path);
      const info = file.path.replace(/\.pgn$/i, ".info");
      if (await exists(info)) await remove(info);
      removeDecks(file.path);
      scheduleSync(MOVE_SYNC_DELAY, joinPath(dir, `${cleaned[0]}.pgn`));
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      opened={file !== null}
      onClose={onClose}
      title={t("Repertoires.SplitTitle", { name: file?.name ?? "" })}
    >
      <Stack>
        <Text size="sm">{t("Repertoires.SplitDesc", { group: groupName })}</Text>
        {names.map((name, i) => (
          <TextInput
            key={i}
            label={t("Repertoires.SectionDefault", { n: i + 1 })}
            value={name}
            onChange={(e) => {
              const value = e.currentTarget.value;
              setNames((prev) => prev.map((n, j) => (j === i ? value : n)));
            }}
          />
        ))}
        {error && (
          <Text c="red" size="sm">
            {error}
          </Text>
        )}
        <Group justify="right">
          <Button variant="default" onClick={onClose}>
            {t("Common.Cancel")}
          </Button>
          <Button loading={busy} disabled={games.length === 0} onClick={confirm}>
            {t("Repertoires.Split")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Renames a group folder; the practice progress of its sections follows it. */
export function RenameGroupModal({
  group,
  onClose,
  onDone,
}: {
  group: { name: string; dir: string } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setName(group?.name ?? "");
    setError("");
  }, [group]);

  async function confirm() {
    if (!group) return;
    const cleaned = safeFileName(name);
    if (!cleaned) return setError(t("Common.RequireName"));
    const target = joinPath(dirName(group.dir), cleaned);
    if (target === group.dir) return onClose();
    try {
      if (await exists(target)) return setError(t("Repertoires.NameExists"));
      await rename(group.dir, target);
      moveDecks(group.dir, target);
      scheduleSync(MOVE_SYNC_DELAY, target);
      onDone();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <Modal opened={group !== null} onClose={onClose} title={t("Repertoires.RenameGroup")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        <Stack>
          <TextInput
            label={t("Repertoires.GroupName")}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            error={error}
            data-autofocus
          />
          <Group justify="right">
            <Button variant="default" onClick={onClose}>
              {t("Common.Cancel")}
            </Button>
            <Button type="submit">{t("Common.Save")}</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
