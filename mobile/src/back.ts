// Android back button: screens shown on top of others (e.g. Analysis) register a
// handler; the most recent one wins, otherwise App's default navigation applies.

import { useEffect, useRef } from "react";

const handlers: (() => void)[] = [];

export function handleBack(): boolean {
    const top = handlers[handlers.length - 1];
    if (!top) return false;
    top();
    return true;
}

export function useBackHandler(handler: () => void) {
    const ref = useRef(handler);
    ref.current = handler;
    useEffect(() => {
        const fn = () => ref.current();
        handlers.push(fn);
        return () => {
            const i = handlers.lastIndexOf(fn);
            if (i >= 0) handlers.splice(i, 1);
        };
    }, []);
}
