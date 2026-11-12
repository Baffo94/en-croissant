import { useEffect, useMemo, useState } from "react";
import { type GroupEntry, homeItems, listRepertoires, type RepertoireEntry } from "../repertoires";
import { setRepertoirePaused, useAppState } from "../state";
import { scheduleSync, syncNow, useSyncStatus } from "../sync";
import { ideaPoints } from "@/utils/ideas";
import { getGameComment } from "../comments";
import { Header } from "./Practice";

const PAUSE_SYNC_DELAY = 3_000;
const EXPANDED_KEY = "home-groups-expanded";

function SyncIndicator() {
  const status = useSyncStatus();
  const label =
    status.state === "syncing"
      ? "Sincronizzazione…"
      : status.state === "error"
        ? `Errore: ${status.message ?? ""}`
        : status.state === "success"
          ? "Sincronizzato"
          : "";
  return <p className={`sync-status ${status.state}`}>{label}</p>;
}

/** Open groups, remembered between sessions (only a convenience). */
function useExpandedGroups(): [Set<string>, (folder: string) => void] {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (folder: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
      } catch {
        // ignore
      }
      return next;
    });
  return [expanded, toggle];
}

type IdeasProps = {
  /** Number of ideas of an entry (its PGN comment before the first move). */
  ideasOf: (entry: RepertoireEntry) => number;
  onIdeas: (entry: RepertoireEntry) => void;
};

function EntryItem({
  entry,
  onOpen,
  section = false,
  ideasOf,
  onIdeas,
}: {
  entry: RepertoireEntry;
  onOpen: (entry: RepertoireEntry) => void;
  section?: boolean;
} & IdeasProps) {
  const ideas = ideasOf(entry);
  return (
    <li className="entry-row">
      <button
        type="button"
        className={`item${section ? " section" : ""}${entry.paused ? " is-paused" : ""}`}
        onClick={() => onOpen(entry)}
      >
        {!section && <span className={`color-dot ${entry.orientation}`} />}
        <span className="item-main">
          <span className="item-name">{entry.name}</span>
          {!section && entry.folder && <span className="item-folder">{entry.folder}</span>}
        </span>
        <span className="item-stats">
          {entry.paused ? (
            <span className="pill">⏸</span>
          ) : (
            <>
              {entry.stats.due > 0 && <span className="pill due">{entry.stats.due}</span>}
              {entry.stats.unseen > 0 && <span className="pill new">{entry.stats.unseen}</span>}
            </>
          )}
          <span className="item-total">{entry.stats.total}</span>
        </span>
      </button>
      <button
        type="button"
        className={`ideas-btn${ideas ? " has" : ""}`}
        aria-label={ideas ? `Idee della variante (${ideas})` : "Aggiungi le idee della variante"}
        onClick={() => onIdeas(entry)}
      >
        💡
      </button>
    </li>
  );
}

function GroupItem({
  group,
  expanded,
  onToggle,
  onOpen,
  onTrain,
  ideasOf,
  onIdeas,
}: {
  group: GroupEntry;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (entry: RepertoireEntry) => void;
  onTrain: (group: GroupEntry) => void;
} & IdeasProps) {
  const toDo = group.stats.due + group.stats.unseen;
  return (
    <li className={`group${expanded ? " open" : ""}`}>
      <button type="button" className="item group-head" onClick={onToggle}>
        <span className={`color-dot ${group.orientation}`} />
        <span className="item-main">
          <span className="item-name">
            <span className="chevron">{expanded ? "▾" : "▸"}</span> {group.name}
          </span>
          <span className="item-folder">
            {group.sections.length === 1 ? "1 sezione" : `${group.sections.length} sezioni`}
          </span>
        </span>
        <span className="item-stats">
          {group.paused ? (
            <span className="pill">⏸</span>
          ) : (
            <>
              {group.stats.due > 0 && <span className="pill due">{group.stats.due}</span>}
              {group.stats.unseen > 0 && <span className="pill new">{group.stats.unseen}</span>}
            </>
          )}
          <span className="item-total">{group.stats.total}</span>
        </span>
      </button>
      {expanded && (
        <div className="group-body">
          <ul className="list sections">
            {group.sections.map((e) => (
              <EntryItem
                key={`${e.rel}#${e.game}`}
                entry={e}
                onOpen={onOpen}
                section
                ideasOf={ideasOf}
                onIdeas={onIdeas}
              />
            ))}
          </ul>
          <div className="group-actions">
            {toDo > 0 && (
              <button type="button" className="primary" onClick={() => onTrain(group)}>
                Allena il gruppo ({toDo})
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                const pause = !group.paused;
                for (const s of group.sections) {
                  if (s.paused !== pause) setRepertoirePaused(s.rel, pause);
                }
                scheduleSync(PAUSE_SYNC_DELAY);
              }}
            >
              {group.paused ? "▶ Riattiva il gruppo" : "⏸ Pausa gruppo"}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export function Home({
  onOpen,
  onTrainAll,
  onTrainGroup,
  onSettings,
  onIdeas,
}: {
  onOpen: (entry: RepertoireEntry) => void;
  onTrainAll: (entries: RepertoireEntry[]) => void;
  onTrainGroup: (name: string, entries: RepertoireEntry[]) => void;
  onSettings: () => void;
  onIdeas: (entry: RepertoireEntry) => void;
}) {
  const files = useAppState((s) => s.files);
  const decks = useAppState((s) => s.decks);
  const pauses = useAppState((s) => s.pauses);
  const lastSync = useAppState((s) => s.manifest?.lastSync ?? null);
  const status = useSyncStatus();
  const [expanded, toggle] = useExpandedGroups();
  // Recomputed every minute: positions answered wrongly become due again shortly.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const all = useMemo(
    () => listRepertoires({ files, decks, pauses }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, decks, pauses, tick],
  );
  const ideasCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of all)
      counts.set(`${e.rel}#${e.game}`, ideaPoints(getGameComment(e.rel, e.game)).length);
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, all]);
  const ideasOf = (e: RepertoireEntry) => ideasCount.get(`${e.rel}#${e.game}`) ?? 0;
  const entries = all.filter((e) => !e.paused);
  const items = homeItems(all);
  const isPaused = (i: (typeof items)[number]) =>
    i.kind === "entry" ? i.entry.paused : i.group.paused;
  const activeItems = items.filter((i) => !isPaused(i));
  const pausedItems = items.filter(isPaused);

  const totals = entries.reduce(
    (t, e) => ({
      due: t.due + e.stats.due,
      unseen: t.unseen + e.stats.unseen,
      positions: t.positions + e.stats.total,
    }),
    { due: 0, unseen: 0, positions: 0 },
  );
  const totalDue = totals.due + totals.unseen;

  const renderItem = (item: (typeof items)[number]) =>
    item.kind === "entry" ? (
      <EntryItem
        key={`${item.entry.rel}#${item.entry.game}`}
        entry={item.entry}
        onOpen={onOpen}
        ideasOf={ideasOf}
        onIdeas={onIdeas}
      />
    ) : (
      <GroupItem
        key={`group:${item.group.folder}`}
        group={item.group}
        expanded={expanded.has(item.group.folder)}
        onToggle={() => toggle(item.group.folder)}
        onOpen={onOpen}
        onTrain={(g) => onTrainGroup(g.name, g.active)}
        ideasOf={ideasOf}
        onIdeas={onIdeas}
      />
    );

  return (
    <div className="screen">
      <Header
        title="Repertori"
        right={
          <>
            <button
              type="button"
              className="icon"
              aria-label="Sincronizza"
              disabled={status.state === "syncing"}
              onClick={() => void syncNow().catch(() => {})}
            >
              ⟳
            </button>
            <button type="button" className="icon" aria-label="Impostazioni" onClick={onSettings}>
              ⚙
            </button>
          </>
        }
      />
      <SyncIndicator />
      {all.length === 0 ? (
        <div className="empty">
          <p>Nessun repertorio.</p>
          <p className="small">
            Sul PC metti i repertori nella cartella sincronizzata di En Croissant, poi tocca ⟳.
          </p>
        </div>
      ) : (
        <>
          <div className="summary-row">
            <p className="summary">
              {totalDue > 0
                ? `${totalDue} posizioni da allenare oggi`
                : "Tutto ripassato per oggi 🎉"}
            </p>
            {totalDue > 0 && (
              <button type="button" className="primary" onClick={() => onTrainAll(entries)}>
                Allena tutto
              </button>
            )}
          </div>
          <ul className="list">{activeItems.map(renderItem)}</ul>
          <p className="legend">
            Totale: <span className="pill due">{totals.due}</span> da ripassare ·{" "}
            <span className="pill new">{totals.unseen}</span> nuove · {totals.positions} posizioni
          </p>
          {pausedItems.length > 0 && (
            <>
              <h2 className="section-title">In pausa</h2>
              <ul className="list paused">{pausedItems.map(renderItem)}</ul>
            </>
          )}
        </>
      )}
      {lastSync && (
        <p className="footer">
          Ultima sincronizzazione: {new Date(lastSync).toLocaleString("it-IT")}
        </p>
      )}
    </div>
  );
}
