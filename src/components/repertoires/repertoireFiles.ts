// The repertoire files (documents folder and synced folder), shared by the Repertoires
// page and the repertoire lookup of the analysis board.

import type { useNavigate } from "@tanstack/react-router";
import { exists, readDir } from "@tauri-apps/plugin-fs";
import type { useSetAtom, useStore } from "jotai";
import { commands } from "@/bindings";
import {
    type Directory,
    type FileMetadata,
    processEntriesRecursively,
} from "@/components/files/file";
import { activeTabAtom, addRecentFileAtom, tabFamily, tabsAtom } from "@/state/atoms";
import { parsePGN } from "@/utils/chess";
import { normalizePath, relativePath } from "@/utils/sync/core";
import { createTab } from "@/utils/tabs";
import { unwrap } from "@/utils/unwrap";
import { groupOf } from "./groups";

export type RepertoireFile = FileMetadata & {
    inSyncFolder: boolean;
    folder: string;
    /** Repertoires folder the file belongs to (sync folder or documents). */
    base: string;
    /** Group (subfolder of `base`) the file is a section of; "" for none. */
    group: string;
};

/** Name shown while practising: "Group · Section" for a section of a group. */
export function practiceLabel(file: RepertoireFile): string {
    return file.group ? `${file.group.split("/").pop()} · ${file.name}` : file.name;
}

function flatten(entries: (FileMetadata | Directory)[]): FileMetadata[] {
    return entries.flatMap((e) => (e.type === "directory" ? flatten(e.children) : [e]));
}

export async function listRepertoires(documentDir: string, syncFolder: string | null) {
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
            const inSyncFolder =
                syncFolder !== null && relativePath(syncFolder, file.path) !== null;
            const base = inSyncFolder && syncFolder ? syncFolder : root;
            files.push({ ...file, folder, inSyncFolder, base, group: groupOf(base, file.path) });
        }
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
}

type Deps = {
    setTabs: ReturnType<typeof useSetAtom<typeof tabsAtom>>;
    setActiveTab: ReturnType<typeof useSetAtom<typeof activeTabAtom>>;
    store: ReturnType<typeof useStore>;
    navigate: ReturnType<typeof useNavigate>;
};

/** Opens a repertoire in a new tab, optionally on a position (the line of moves from its start). */
export async function openRepertoireTab(
    file: RepertoireFile | FileMetadata,
    { practice = false, at }: { practice?: boolean; at?: { game: number; line: string[] } },
    { setTabs, setActiveTab, store, navigate }: Deps,
) {
    const game = at?.game ?? 0;
    const [pgnResult, countResult] = await Promise.all([
        commands.readGames(file.path, game, game),
        commands.countPgnGames(file.path),
    ]);
    const pgn = unwrap(pgnResult)[0] ?? "";
    // Opened on a given position: path of child indices.
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
        tab: { name: "group" in file ? practiceLabel(file) : file.name, type: "analysis" },
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
