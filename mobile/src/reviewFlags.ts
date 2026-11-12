// Moves flagged "to review" on the phone, to be found again on the PC. Stored per PGN
// in the app state and synced through the progress files (see utils/flags).

import { type ReviewFlag, flagAt, setFlag } from "@/utils/flags";
import { getState, updateState, useAppState } from "./state";
import { scheduleSync } from "./sync";

const FLAG_SYNC_DELAY = 3_000;
const DEVICE = "Telefono";
const EMPTY: ReviewFlag[] = [];

export type FlagProps = {
    flag: ReviewFlag | undefined;
    /** Saves the note of the flag; an empty text resolves it. */
    onSave: (text: string) => void;
};

/** Flags of a PGN file (resolved ones included), reactive. */
export function useFlags(rel: string | null): ReviewFlag[] {
    return useAppState((s) => (rel ? (s.flags?.[rel] ?? EMPTY) : EMPTY));
}

/** Adds, changes or (empty text) resolves the flag of a move, then syncs. */
export function saveFlag(rel: string, game: number, line: string[], text: string): void {
    const current = getState().flags?.[rel] ?? [];
    const next = setFlag(current, game, line, text, DEVICE);
    updateState((s) => ({ ...s, flags: { ...s.flags, [rel]: next } }));
    scheduleSync(FLAG_SYNC_DELAY);
}

export function flagProps(
    flags: readonly ReviewFlag[],
    rel: string,
    game: number,
    line: string[],
): FlagProps {
    return {
        flag: flagAt(flags, game, line),
        onSave: (text) => saveFlag(rel, game, line, text),
    };
}

/** Open flags of every repertoire. */
export function useOpenFlagCount(): number {
    return useAppState((s) =>
        Object.values(s.flags ?? {}).reduce(
            (n, list) => n + list.filter((f) => !f.resolvedAt).length,
            0,
        ),
    );
}
