import { describe, expect, test } from "vitest";
import {
    emptyStats,
    groupFiles,
    groupOf,
    safeFileName,
    sumStats,
} from "@/components/repertoires/groups";

const base = "C:\\Users\\me\\Documents\\EnCroissant\\Repertori";
const file = (rel: string) => {
    const path = `${base}\\${rel.replace(/\//g, "\\")}`;
    return {
        path,
        name: rel
            .split("/")
            .pop()!
            .replace(/\.pgn$/, ""),
        base,
        group: groupOf(base, path),
    };
};

describe("variant groups", () => {
    test("group of a file is its folder below the repertoires folder", () => {
        expect(file("Italiana.pgn").group).toBe("");
        expect(file("Caro Kann/Panov.pgn").group).toBe("Caro Kann");
        expect(file("A/B/C.pgn").group).toBe("A/B");
    });

    test("files are listed alone or collected into their group, sorted by name", () => {
        const listed = groupFiles([
            file("Scotch.pgn"),
            file("Caro Kann/Principale.pgn"),
            file("Albin.pgn"),
            file("Caro Kann/Panov.pgn"),
        ]);
        expect(listed.map((l) => (l.kind === "file" ? l.file.name : `[${l.name}]`))).toEqual([
            "Albin",
            "[Caro Kann]",
            "Scotch",
        ]);
        const group = listed[1];
        expect(group.kind === "group" && group.files.map((f) => f.name)).toEqual([
            "Panov",
            "Principale",
        ]);
        expect(group.kind === "group" && group.dir).toBe(`${base}\\Caro Kann`);
    });

    test("group statistics add up the sections", () => {
        const a = { ...emptyStats(), total: 10, due: 2, unseen: 1, learned: 7, reviews: 5 };
        const b = { ...emptyStats(), total: 5, due: 1, unseen: 0, learned: 4, reviews: 3 };
        a.nextDue = new Date("2026-11-10");
        b.nextDue = new Date("2026-11-08");
        a.lastReview = new Date("2026-11-01");
        b.lastReview = new Date("2026-11-05");
        const sum = sumStats([a, b]);
        expect(sum).toMatchObject({ total: 15, due: 3, unseen: 1, learned: 11, reviews: 8 });
        expect(sum.nextDue).toEqual(b.nextDue);
        expect(sum.lastReview).toEqual(b.lastReview);
    });

    test("names usable as file names", () => {
        expect(safeFileName("Caro Kann: Panov / Botvinnik?")).toBe("Caro Kann- Panov - Botvinnik-");
        expect(safeFileName("  Principale.  ")).toBe("Principale");
    });
});
