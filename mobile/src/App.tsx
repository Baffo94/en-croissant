import { App as CapApp } from "@capacitor/app";
import { useEffect, useRef, useState } from "react";
import { handleBack } from "./back";
import { Home } from "./components/Home";
import { Practice, type PracticeSource } from "./components/Practice";
import { Settings } from "./components/Settings";
import { flushState, getState, useAppState } from "./state";
import { isConfigured, syncNow } from "./sync";

type Screen =
  | { kind: "home" }
  | { kind: "settings" }
  | { kind: "practice"; sources: PracticeSource[]; title: string; mixed: boolean };

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
        if (handleBack()) return;
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
        key={screen.sources.map((s) => `${s.rel}#${s.game}`).join("|")}
        sources={screen.sources}
        title={screen.title}
        mixed={screen.mixed}
        onBack={() => setScreen({ kind: "home" })}
      />
    );
  }
  return (
    <Home
      onOpen={(entry) =>
        setScreen({
          kind: "practice",
          sources: [{ rel: entry.rel, game: entry.game, name: entry.name }],
          title: entry.name,
          mixed: false,
        })
      }
      onTrainAll={(entries) =>
        setScreen({
          kind: "practice",
          sources: entries.map((e) => ({ rel: e.rel, game: e.game, name: e.name })),
          title: "Allena tutto",
          mixed: true,
        })
      }
      onTrainGroup={(name, entries) =>
        setScreen({
          kind: "practice",
          sources: entries.map((e) => ({ rel: e.rel, game: e.game, name: e.name })),
          title: name,
          mixed: true,
        })
      }
      onSettings={() => setScreen({ kind: "settings" })}
    />
  );
}
