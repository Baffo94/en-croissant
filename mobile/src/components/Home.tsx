import { useMemo } from "react";
import { listRepertoires, type RepertoireEntry } from "../repertoires";
import { useAppState } from "../state";
import { syncNow, useSyncStatus } from "../sync";
import { Header } from "./Practice";

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

export function Home({
  onOpen,
  onTrainAll,
  onSettings,
}: {
  onOpen: (entry: RepertoireEntry) => void;
  onTrainAll: (entries: RepertoireEntry[]) => void;
  onSettings: () => void;
}) {
  const files = useAppState((s) => s.files);
  const decks = useAppState((s) => s.decks);
  const pauses = useAppState((s) => s.pauses);
  const lastSync = useAppState((s) => s.manifest?.lastSync ?? null);
  const status = useSyncStatus();
  const all = useMemo(() => listRepertoires({ files, decks, pauses }), [files, decks, pauses]);
  const entries = all.filter((e) => !e.paused);
  const pausedEntries = all.filter((e) => e.paused);

  const totals = entries.reduce(
    (t, e) => ({
      due: t.due + e.stats.due,
      unseen: t.unseen + e.stats.unseen,
      positions: t.positions + e.stats.total,
    }),
    { due: 0, unseen: 0, positions: 0 },
  );
  const totalDue = totals.due + totals.unseen;

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
          <ul className="list">
            {entries.map((e) => (
              <li key={`${e.rel}#${e.game}`}>
                <button type="button" className="item" onClick={() => onOpen(e)}>
                  <span className={`color-dot ${e.orientation}`} />
                  <span className="item-main">
                    <span className="item-name">{e.name}</span>
                    {e.folder && <span className="item-folder">{e.folder}</span>}
                  </span>
                  <span className="item-stats">
                    {e.stats.due > 0 && <span className="pill due">{e.stats.due}</span>}
                    {e.stats.unseen > 0 && <span className="pill new">{e.stats.unseen}</span>}
                    <span className="item-total">{e.stats.total}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="legend">
            Totale: <span className="pill due">{totals.due}</span> da ripassare ·{" "}
            <span className="pill new">{totals.unseen}</span> nuove · {totals.positions} posizioni
          </p>
          {pausedEntries.length > 0 && (
            <>
              <h2 className="section-title">In pausa</h2>
              <ul className="list paused">
                {pausedEntries.map((e) => (
                  <li key={`${e.rel}#${e.game}`}>
                    <button type="button" className="item" onClick={() => onOpen(e)}>
                      <span className={`color-dot ${e.orientation}`} />
                      <span className="item-main">
                        <span className="item-name">{e.name}</span>
                        {e.folder && <span className="item-folder">{e.folder}</span>}
                      </span>
                      <span className="item-stats">
                        <span className="pill">⏸</span>
                        <span className="item-total">{e.stats.total}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
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
