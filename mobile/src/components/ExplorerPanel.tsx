import { useEffect, useState } from "react";
import {
  type ExplorerDb,
  ExplorerError,
  type ExplorerResult,
  fetchExplorer,
  formatGames,
} from "../explorer";
import { updateState, useAppState } from "../state";

function pct(n: number, total: number): number {
  return total > 0 ? (n / total) * 100 : 0;
}

function ResultBar({ white, draws, black }: { white: number; draws: number; black: number }) {
  const total = white + draws + black;
  const w = pct(white, total);
  const d = pct(draws, total);
  const b = pct(black, total);
  const label = (v: number) => (v >= 12 ? `${Math.round(v)}%` : "");
  return (
    <div className="wdl">
      <span className="wdl-white" style={{ width: `${w}%` }}>
        {label(w)}
      </span>
      <span className="wdl-draw" style={{ width: `${d}%` }}>
        {label(d)}
      </span>
      <span className="wdl-black" style={{ width: `${b}%` }}>
        {label(b)}
      </span>
    </div>
  );
}

/** Moves played from `fen` in the Lichess opening explorer; tapping one plays it. */
export const TOKEN_URL =
  "https://lichess.org/account/oauth/token/create?description=En%20Croissant%20mobile";

/** Field to enter the Lichess token (used in settings and when the explorer asks for it). */
export function LichessTokenInput() {
  const token = useAppState((s) => s.explorer.token);
  const [value, setValue] = useState(token);
  const [show, setShow] = useState(false);
  return (
    <div className="token-form">
      <div className="row">
        <input
          type={show ? "text" : "password"}
          value={value}
          placeholder="lip_..."
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="button" onClick={() => setShow((v) => !v)}>
          {show ? "Nascondi" : "Mostra"}
        </button>
      </div>
      <div className="row">
        <a className="link" href={TOKEN_URL} target="_blank" rel="noreferrer">
          Crea un token su Lichess
        </a>
        <button
          type="button"
          className="primary"
          disabled={value.trim() === token}
          onClick={() =>
            updateState((s) => ({ ...s, explorer: { ...s.explorer, token: value.trim() } }))
          }
        >
          Salva
        </button>
      </div>
    </div>
  );
}

export function ExplorerPanel({ fen, onPlay }: { fen: string; onPlay: (uci: string) => void }) {
  const settings = useAppState((s) => s.explorer);
  const [db, setDb] = useState<ExplorerDb>("masters");
  const [result, setResult] = useState<ExplorerResult | null>(null);
  const [error, setError] = useState<ExplorerError | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Small delay so that stepping through moves quickly doesn't flood Lichess.
    const timer = setTimeout(() => {
      fetchExplorer(db, fen, settings)
        .then((r) => !cancelled && setResult(r))
        .catch((e) => {
          if (cancelled) return;
          setResult(null);
          setError(e instanceof ExplorerError ? e : new ExplorerError(String(e), "other"));
        })
        .finally(() => !cancelled && setLoading(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [db, fen, settings]);

  const total = result ? result.white + result.draws + result.black : 0;
  const levels = settings.ratings.length > 0 ? `${Math.min(...settings.ratings)}+` : "";

  return (
    <div className="explorer">
      <div className="segmented">
        <button
          type="button"
          className={db === "masters" ? "active" : ""}
          onClick={() => setDb("masters")}
        >
          Maestri
        </button>
        <button
          type="button"
          className={db === "lichess" ? "active" : ""}
          onClick={() => setDb("lichess")}
        >
          Lichess {levels && <small>{levels}</small>}
        </button>
      </div>

      {result?.opening && (
        <p className="opening-name">
          <strong>{result.opening.eco}</strong> {result.opening.name}
        </p>
      )}

      {error && (
        <div className="explorer-error">
          <p>{error.message}</p>
          {error.kind === "token" && (
            <>
              <p className="small">
                Su Lichess: Preferenze → Token di accesso API → nuovo token, senza selezionare
                permessi.
              </p>
              <LichessTokenInput />
            </>
          )}
        </div>
      )}

      {!error && result && result.moves.length === 0 && (
        <p className="dim">
          Nessuna partita {db === "masters" ? "di maestri" : "su Lichess"} da questa posizione.
        </p>
      )}

      {!error && result && result.moves.length > 0 && (
        <table className="explorer-table">
          <thead>
            <tr>
              <th>Mossa</th>
              <th>Partite</th>
              <th>Bianco / Patta / Nero</th>
            </tr>
          </thead>
          <tbody>
            {result.moves.map((m) => {
              const games = m.white + m.draws + m.black;
              return (
                <tr key={m.uci} onClick={() => onPlay(m.uci)}>
                  <td className="san">{m.san}</td>
                  <td className="games">
                    {formatGames(games)}
                    <small>{Math.round(pct(games, total))}%</small>
                  </td>
                  <td>
                    <ResultBar white={m.white} draws={m.draws} black={m.black} />
                  </td>
                </tr>
              );
            })}
            <tr className="total">
              <td>Σ</td>
              <td className="games">{formatGames(total)}</td>
              <td>
                <ResultBar white={result.white} draws={result.draws} black={result.black} />
              </td>
            </tr>
          </tbody>
        </table>
      )}
      {loading && !result && !error && <p className="dim">Carico l'esploratore…</p>}
      <p className="engine-credit">Dati: esploratore aperture di Lichess</p>
    </div>
  );
}
