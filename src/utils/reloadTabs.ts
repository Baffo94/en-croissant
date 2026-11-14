// Open tabs of a file changed outside them (downloaded by the sync, an edit from the
// phone undone here) are read again from the file, unless they have unsaved changes:
// then they are left alone (and listed, so the user can be told).

import { getDefaultStore } from "jotai";
import { commands } from "@/bindings";
import { liveTree } from "@/state/store/liveTrees";
import { createDebouncedSessionStorage } from "@/state/store/debouncedStorage";
import { tabsAtom } from "@/state/atoms";
import { parsePGN } from "./chess";
import { getTabFile, getTabGameNumber, type Tab } from "./tabs";
import type { TreeState } from "./treeReducer";
import type { TreeNode } from "./treeReducer";
import { unwrap } from "./unwrap";

const storage = createDebouncedSessionStorage<TreeState>();

/** Tabs showing a file for which `matches(path)` holds. */
export function tabsOfFiles(matches: (path: string) => boolean): Tab[] {
    return getDefaultStore()
        .get(tabsAtom)
        .filter((tab) => {
            const file = getTabFile(tab);
            return !!file && matches(file.path);
        });
}

export function tabIsDirty(tab: Tab): boolean {
    const store = liveTree(tab.value);
    if (store) return store.getState().dirty;
    return storage.getItem(tab.value)?.state?.dirty ?? false;
}

/** Reloads the given tabs from their file; returns the tabs left alone (unsaved changes). */
export async function reloadTabs(tabs: readonly Tab[]): Promise<Tab[]> {
    const skipped: Tab[] = [];
    for (const tab of tabs) {
        const file = getTabFile(tab);
        if (!file) continue;
        if (tabIsDirty(tab)) {
            skipped.push(tab);
            continue;
        }
        try {
            const game = getTabGameNumber(tab);
            const data = unwrap(await commands.readGames(file.path, game, game));
            if (!data[0]) continue;
            const tree = await parsePGN(data[0]);
            const store = liveTree(tab.value);
            const current = store ? store.getState() : storage.getItem(tab.value)?.state;
            // Stay on the same move (found by its moves, indices may have changed), or as
            // close to it as the new version allows.
            const position = current
                ? samePlace(current.root, current.position, tree.root)
                : tree.position;
            if (store) {
                store.getState().setState({ ...store.getState(), ...tree, position, dirty: false });
            } else {
                const stored = storage.getItem(tab.value);
                if (!stored) continue; // never opened: it reads the file when shown
                storage.setItem(tab.value, {
                    ...stored,
                    state: { ...stored.state, ...tree, position, dirty: false },
                });
            }
        } catch {
            // The file could not be read: the tab keeps what it shows.
        }
    }
    return skipped;
}

/** Path in `to` of the moves that lead to `path` in `from` (as far as they exist). */
function samePlace(from: TreeNode, path: number[], to: TreeNode): number[] {
    const out: number[] = [];
    let a = from;
    let b = to;
    for (const i of path) {
        const next = a.children[i];
        if (!next) break;
        const j = b.children.findIndex((c) => c.san === next.san);
        if (j < 0) break;
        out.push(j);
        a = next;
        b = b.children[j];
    }
    return out;
}
