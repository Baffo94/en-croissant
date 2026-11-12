import { describe, expect, test } from "vitest";
import { flagAt, flagMoveLabel, mergeFlags, openFlags, resolveFlag, setFlag } from "@/utils/flags";

const t = (iso: string) => new Date(iso);

describe("review flags", () => {
    test("add, change, resolve with an empty text", () => {
        const line = ["e4", "e5", "Nf3"];
        let flags = setFlag([], 0, line, "  Rivedere ", "Android", t("2026-11-13T10:00:00Z"));
        expect(flags).toHaveLength(1);
        expect(flagAt(flags, 0, line)?.text).toBe("Rivedere");
        expect(flagAt(flags, 1, line)).toBeUndefined();
        flags = setFlag(flags, 0, line, "Meglio Bc4", "Android", t("2026-11-13T11:00:00Z"));
        expect(flags).toHaveLength(1);
        expect(flags[0].text).toBe("Meglio Bc4");
        flags = setFlag(flags, 0, line, "", "Android", t("2026-11-13T12:00:00Z"));
        expect(openFlags(flags)).toHaveLength(0);
        expect(flags[0].resolvedAt).toBe("2026-11-13T12:00:00.000Z");
        // A new flag on the same move after resolution is a new one.
        flags = setFlag(flags, 0, line, "Di nuovo", "PC", t("2026-11-14T10:00:00Z"));
        expect(flags).toHaveLength(2);
        expect(setFlag([], 0, line, "   ", "PC")).toEqual([]);
    });

    test("merge: union by id, newest version wins, old resolved ones dropped", () => {
        const a = setFlag([], 0, ["d4"], "A", "PC", t("2026-11-01T00:00:00Z"));
        const b = resolveFlag(a, a[0].id, t("2026-11-02T00:00:00Z"));
        const other = setFlag([], 0, ["e4"], "B", "Android", t("2026-11-03T00:00:00Z"));
        const merged = mergeFlags(a, [...b, ...other], t("2026-11-05T00:00:00Z"));
        expect(merged.map((f) => [f.text, !!f.resolvedAt])).toEqual([
            ["A", true],
            ["B", false],
        ]);
        expect(mergeFlags(b, a, t("2026-11-05T00:00:00Z"))[0].resolvedAt).toBeDefined();
        expect(mergeFlags(b, [], t("2027-03-01T00:00:00Z"))).toEqual([]);
    });

    test("move label", () => {
        expect(flagMoveLabel({ line: ["e4", "e5", "Nf3", "d6", "d4", "exd4", "Nxd4"] })).toBe(
            "4. Nxd4",
        );
        expect(flagMoveLabel({ line: ["e4", "e5"] })).toBe("1... e5");
    });
});
