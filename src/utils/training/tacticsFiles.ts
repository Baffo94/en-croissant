// The collections of your tactics on the PC: "Tattiche/<collection>.pgn" in the synced
// folder (so that the phone gets them), or in the documents folder without sync.

import { exists, mkdir, readDir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { getDefaultStore } from "jotai";
import { getDocumentDir } from "@/utils/directories";
import { isConfigured, resolveSyncFolder, scheduleSync, syncConfigAtom } from "@/utils/sync";
import {
    appendTactic,
    type MyTactic,
    newTacticId,
    parseCollection,
    TACTICS_FILE_TYPE,
    TACTICS_FOLDER,
    tacticPgn,
} from "./myTactics";
import type { TreeNode } from "@/utils/treeReducer";

const sepOf = (path: string) => (path.includes("\\") ? "\\" : "/");

export async function tacticsFolder(): Promise<string> {
    const config = getDefaultStore().get(syncConfigAtom);
    const base = isConfigured(config) ? await resolveSyncFolder(config) : await getDocumentDir();
    return `${base.replace(/[\\/]+$/, "")}${sepOf(base)}${TACTICS_FOLDER}`;
}

/** True for a file of a collection (to tell a tactic's tab from an ordinary one). */
export function isTacticsFile(path: string | undefined | null): boolean {
    return !!path && /[\\/]Tattiche[\\/][^\\/]+\.pgn$/i.test(path);
}

/** Names usable as file names: no path separators or characters Windows refuses. */
export function cleanCollectionName(name: string): string {
    return name
        .replace(/[\\/:*?"<>|]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\.+$/, "");
}

export type Collection = { name: string; path: string; tactics: MyTactic[] };

export async function listCollections(): Promise<Collection[]> {
    const folder = await tacticsFolder();
    if (!(await exists(folder))) return [];
    const sep = sepOf(folder);
    const collections: Collection[] = [];
    for (const entry of await readDir(folder)) {
        if (!entry.isFile || !entry.name.toLowerCase().endsWith(".pgn")) continue;
        const path = `${folder}${sep}${entry.name}`;
        const name = entry.name.replace(/\.pgn$/i, "");
        try {
            collections.push({
                name,
                path,
                tactics: parseCollection(await readTextFile(path), name, path),
            });
        } catch {
            collections.push({ name, path, tactics: [] });
        }
    }
    return collections.sort((a, b) => a.name.localeCompare(b.name));
}

/** Adds a tactic (the position at `root` and its lines) to a collection, created if new. */
export async function saveTactic(
    collection: string,
    tags: string[],
    root: TreeNode,
): Promise<string> {
    const folder = await tacticsFolder();
    if (!(await exists(folder))) await mkdir(folder, { recursive: true });
    const name = cleanCollectionName(collection);
    const path = `${folder}${sepOf(folder)}${name}.pgn`;
    const info = path.replace(/\.pgn$/i, ".info");
    const before = (await exists(path)) ? await readTextFile(path) : null;
    const id = newTacticId();
    await writeTextFile(
        path,
        appendTactic(before, tacticPgn({ collection: name, id, tags, root })),
    );
    if (!(await exists(info))) {
        await writeTextFile(info, JSON.stringify({ type: TACTICS_FILE_TYPE, tags: [] }));
    }
    scheduleSync(3000, path);
    return path;
}
