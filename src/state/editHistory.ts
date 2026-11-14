// History of the repertoire edits made on the phone, on the PC: kept in localStorage and
// synced as training/edits.json. From here an edit can be undone.

import { atom, getDefaultStore } from "jotai";
import {
    type EditEntry,
    type EditHistory,
    type HistoryStore,
    parseHistory,
} from "@/utils/editHistory";
import { stableJson } from "@/utils/training/trainingDocs";

const KEY = "repertoire-edit-history";

function read(): string | null {
    try {
        return localStorage.getItem(KEY);
    } catch {
        return null;
    }
}

export const editHistoryAtom = atom<EditHistory>(parseHistory(read()));

function save(history: EditHistory) {
    localStorage.setItem(KEY, stableJson(history));
    getDefaultStore().set(editHistoryAtom, history);
}

export function markUndone(id: string, at = new Date().toISOString()) {
    const history = getDefaultStore().get(editHistoryAtom);
    save({
        version: 1,
        entries: history.entries.map((e: EditEntry) => (e.id === id ? { ...e, undoneAt: at } : e)),
    });
}

export const desktopHistoryStore: HistoryStore = {
    read: () => {
        const history = getDefaultStore().get(editHistoryAtom);
        return history.entries.length > 0 ? stableJson(history) : null;
    },
    write: (text) => save(parseHistory(text)),
};
