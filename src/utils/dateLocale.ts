// Dates and "in 3 days" follow the language chosen in the settings (dayjs otherwise
// always speaks English).

import dayjs from "dayjs";
import "dayjs/locale/be";
import "dayjs/locale/de";
import "dayjs/locale/en-gb";
import "dayjs/locale/es";
import "dayjs/locale/fr";
import "dayjs/locale/it";
import "dayjs/locale/ko";
import "dayjs/locale/nb";
import "dayjs/locale/pl";
import "dayjs/locale/pt";
import "dayjs/locale/ru";
import "dayjs/locale/tr";
import "dayjs/locale/uk";
import "dayjs/locale/zh-cn";
import "dayjs/locale/zh-tw";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

const DAYJS_LOCALES: Record<string, string> = {
    "en-US": "en",
    "en-GB": "en-gb",
    "zh-CN": "zh-cn",
    "zh-TW": "zh-tw",
};

/** dayjs locale for an i18next language ("it-IT" → "it"). */
export function dayjsLocale(language: string | undefined): string {
    if (!language) return "en";
    return DAYJS_LOCALES[language] ?? language.split("-")[0].toLowerCase();
}

export function applyDateLocale(language: string | undefined) {
    dayjs.locale(dayjsLocale(language));
}

/** "14 nov, 10:30" in the language of the app. */
export function formatShortDateTime(date: Date | number, language: string | undefined): string {
    try {
        return new Intl.DateTimeFormat(language || "en-US", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
        }).format(date);
    } catch {
        return dayjs(date).format("D MMM, HH:mm");
    }
}
