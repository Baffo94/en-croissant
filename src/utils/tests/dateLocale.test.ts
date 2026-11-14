import dayjs from "dayjs";
import { afterEach, expect, test } from "vitest";
import { applyDateLocale, dayjsLocale, formatShortDateTime } from "../dateLocale";

afterEach(() => applyDateLocale("en-US"));

test("i18next languages map to dayjs locales", () => {
    expect(dayjsLocale("it-IT")).toBe("it");
    expect(dayjsLocale("en-US")).toBe("en");
    expect(dayjsLocale("en-GB")).toBe("en-gb");
    expect(dayjsLocale("zh-TW")).toBe("zh-tw");
    expect(dayjsLocale(undefined)).toBe("en");
});

test("relative dates and short dates in Italian", () => {
    applyDateLocale("it-IT");
    expect(dayjs().add(3, "day").fromNow()).toBe("tra 3 giorni");
    const date = new Date(2026, 10, 14, 9, 5);
    expect(formatShortDateTime(date, "it-IT")).toMatch(/14 nov/);
    expect(formatShortDateTime(date, "en-US")).toMatch(/Nov 14/);
});
