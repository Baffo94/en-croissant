import { App as CapApp } from "@capacitor/app";
import { useEffect, useRef, useState } from "react";
import { Home } from "./components/Home";
import { Practice } from "./components/Practice";
import { Settings } from "./components/Settings";
import type { RepertoireEntry } from "./repertoires";
import { flushState, getState, useAppState } from "./state";
import { isConfigured, syncNow } from "./sync";

type Screen =
  | { kind: "home" }
  | { kind: "settings" }
  | { kind: "practice"; entry: RepertoireEntry };

export function App() {
  const configured = useAppState((s) => isConfigured(s.config));
  const [screen, setScreen] = useState<Screen>(() =>
    isConfigured(getState().config) ? { kind: "home" } : { kind: "settings" },
  );
  const screenRef = useRef(screen);
  screenRef.current = screen;

  useEffect(() => {
    if (isConfigured(getState().config)) void syncNow().catch(() => {});

    const subs = [
      CapApp.addListener("backButton", () => {
        if (screenRef.current.kind !== "home") setScreen({ kind: "home" });
        else void CapApp.exitApp();
      }),
      CapApp.addListener("resume", () => {
        if (isConfigured(getState().config)) void syncNow().catch(() => {});
      }),
      CapApp.addListener("pause", () => {
        void flushState();
      }),
    ];
    return () => {
      for (const s of subs) void s.then((h) => h.remove());
    };
  }, []);

  if (!configured || screen.kind === "settings") {
    return (
      <Settings
        onBack={
          configured && screen.kind === "settings" && getState().manifest
            ? () => setScreen({ kind: "home" })
            : undefined
        }
        onSaved={() => setScreen({ kind: "home" })}
      />
    );
  }
  if (screen.kind === "practice") {
    return (
      <Practice
        key={`${screen.entry.rel}#${screen.entry.game}`}
        rel={screen.entry.rel}
        game={screen.entry.game}
        name={screen.entry.name}
        onBack={() => setScreen({ kind: "home" })}
      />
    );
  }
  return (
    <Home
      onOpen={(entry) => setScreen({ kind: "practice", entry })}
      onSettings={() => setScreen({ kind: "settings" })}
    />
  );
}
