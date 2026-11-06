// Variant groups: a folder inside the repertoires folder whose PGN files are the
// sections of one repertoire (e.g. "Caro Kann/Panov.pgn", "Caro Kann/Principale.pgn").

import { relativePath } from "@/utils/sync/core";

export type CardStats = {
    total: number;
    due: number;
    unseen: number;
    learned: number;
    nextDue: Date | null;
    lastReview: Date | null;
    reviews: number;
};

export const emptyStats = (): CardStats => ({
    total: 0,
    due: 0,
    unseen: 0,
    learned: 0,
    nextDue: null,
    lastReview: null,
    reviews: 0,
});

/** Statistics of a whole group: sums, earliest next review, latest practice. */
export function sumStats(list: CardStats[]): CardStats {
    const out = emptyStats();
    for (const s of list) {
        out.total += s.total;
        out.due += s.due;
        out.unseen += s.unseen;
        out.learned += s.learned;
        out.reviews += s.reviews;
        if (s.nextDue && (!out.nextDue || s.nextDue < out.nextDue)) out.nextDue = s.nextDue;
        if (s.lastReview && (!out.lastReview || s.lastReview > out.lastReview))
            out.lastReview = s.lastReview;
    }
    return out;
}

/**
 * Group of a file: its folder relative to `base` (the repertoires folder), "" when
 * the file sits directly in it. Nested folders give "A/B".
 */
export function groupOf(base: string, path: string): string {
    const rel = relativePath(base, path);
    if (!rel) return "";
    const slash = rel.lastIndexOf("/");
    return slash >= 0 ? rel.slice(0, slash) : "";
}

export function joinPath(dir: string, ...parts: string[]): string {
    const sep = dir.includes("\\") ? "\\" : "/";
    return [dir.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

export function dirName(path: string): string {
    return path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
}

/** Characters Windows does not allow in file names, replaced so a name is usable. */
export function safeFileName(name: string): string {
    return name
        .replace(/[<>:"/\\|?*]/g, "-")
        .replace(/[. ]+$/, "")
        .trim();
}

export type Listed<F> =
    | { kind: "file"; file: F }
    | { kind: "group"; key: string; name: string; dir: string; files: F[] };

/**
 * Files in the repertoires folder stay single entries; files in a subfolder are
 * collected into one group per folder. Both kinds are sorted by name together.
 */
export function groupFiles<F extends { path: string; name: string; base: string; group: string }>(
    files: F[],
): Listed<F>[] {
    const groups = new Map<string, Listed<F> & { kind: "group" }>();
    const out: Listed<F>[] = [];
    for (const file of files) {
        if (!file.group) {
            out.push({ kind: "file", file });
            continue;
        }
        const key = `${file.base}\n${file.group}`;
        let group = groups.get(key);
        if (!group) {
            const name = file.group.slice(file.group.lastIndexOf("/") + 1);
            group = { kind: "group", key, name, dir: dirName(file.path), files: [] };
            groups.set(key, group);
            out.push(group);
        }
        group.files.push(file);
    }
    for (const g of groups.values()) g.files.sort((a, b) => a.name.localeCompare(b.name));
    const nameOf = (l: Listed<F>) => (l.kind === "file" ? l.file.name : l.name);
    return out.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
}
