import { describe, expect, test } from "vitest";
import { ideaPoints, ideasDraft, ideasText } from "@/utils/ideas";

describe("ideas of a section", () => {
    test("one point per line, bullets optional", () => {
        expect(
            ideaPoints(
                "- Spingere d4\n* Cavallo in d4\n\n• Arrocco corto\n1. e4 apre il gioco\nlibero",
            ),
        ).toEqual([
            "Spingere d4",
            "Cavallo in d4",
            "Arrocco corto",
            "1. e4 apre il gioco",
            "libero",
        ]);
        expect(ideasText(" a \n\n- b")).toBe("- a\n- b");
        expect(ideasDraft("- a\n- b")).toBe("a\nb");
        expect(ideasText("")).toBe("");
        expect(ideaPoints("12.Nf3 è la chiave")).toEqual(["12.Nf3 è la chiave"]);
    });
});
