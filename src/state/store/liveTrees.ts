// Tree stores of the tabs currently on screen, by tab id. The others live in session
// storage until their tab is shown again.

import type { TreeStore } from "./tree";

const live = new Map<string, TreeStore>();

/** Registers the store of a tab on screen; returns the function that unregisters it. */
export function registerLiveTree(id: string, store: TreeStore): () => void {
    live.set(id, store);
    return () => {
        if (live.get(id) === store) live.delete(id);
    };
}

export function liveTree(id: string): TreeStore | undefined {
    return live.get(id);
}
