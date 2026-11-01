import { useState } from "react";
import { applyPieceSet, BOARDS, PIECE_SETS } from "../boardThemes";
import { getState, updateState, useAppState } from "../state";
import { Board } from "./Board";
import { createClient, isConfigured, parseRepository, syncNow } from "../sync";
import { Header } from "./Practice";

export function Settings({ onBack, onSaved }: { onBack?: () => void; onSaved: () => void }) {
  const initial = getState().config;
  const [repository, setRepository] = useState(initial.repository);
  const [token, setToken] = useState(initial.token);
  const [branch, setBranch] = useState(initial.branch || "main");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const config = {
    repository: repository.trim(),
    token: token.trim(),
    branch: branch.trim() || "main",
  };
  const repoValid = repository.trim() === "" || parseRepository(repository) !== null;

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const repo = await createClient(config).getRepo();
      if (!repo.private) {
        setMessage({
          kind: "error",
          text: "Attenzione: il repository è pubblico. Rendilo privato su GitHub.",
        });
      }
      const changed =
        initial.repository !== config.repository || (initial.branch || "main") !== config.branch;
      updateState((s) => ({
        ...s,
        config,
        // A different repository: start from scratch.
        ...(changed && s.manifest ? { files: {}, decks: {}, manifest: null } : {}),
      }));
      await syncNow();
      if (repo.private) onSaved();
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <Header title="Impostazioni" onBack={onBack} />
      <div className="form">
        <p className="small">
          Usa lo stesso repository privato e lo stesso token configurati in En Croissant sul PC
          (Impostazioni → Sincronizzazione).
        </p>
        <label>
          Repository
          <input
            value={repository}
            onChange={(e) => setRepository(e.target.value)}
            placeholder="proprietario/repertorio"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          {!repoValid && <span className="error">Formato atteso: proprietario/nome</span>}
        </label>
        <label>
          Token di accesso
          <div className="row">
            <input
              type={showToken ? "text" : "password"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="github_pat_..."
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <button type="button" onClick={() => setShowToken((v) => !v)}>
              {showToken ? "Nascondi" : "Mostra"}
            </button>
          </div>
          <span className="small">Salvato solo su questo telefono.</span>
        </label>
        <label>
          Branch
          <input value={branch} onChange={(e) => setBranch(e.target.value)} autoCapitalize="none" />
        </label>
        <button
          type="button"
          className="primary"
          disabled={busy || !isConfigured(config)}
          onClick={save}
        >
          {busy ? "Connessione…" : "Salva e sincronizza"}
        </button>
        {message && <p className={message.kind === "error" ? "error" : "ok"}>{message.text}</p>}
      </div>
      <Appearance />
    </div>
  );
}

const PREVIEW_FEN = "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4";

function Appearance() {
  const appearance = useAppState((s) => s.appearance);
  const set = (patch: Partial<typeof appearance>) => {
    updateState((s) => ({ ...s, appearance: { ...s.appearance, ...patch } }));
    if (patch.pieces) applyPieceSet(patch.pieces);
  };
  return (
    <div className="form appearance">
      <h2>Aspetto della scacchiera</h2>
      <div className="preview">
        <Board fen={PREVIEW_FEN} orientation="white" lastMove={["d1", "h5"]} interactive={false} />
      </div>
      <span className="label">Scacchiera</span>
      <div className="tiles">
        {BOARDS.map((b) => (
          <button
            key={b.file}
            type="button"
            className={`tile ${appearance.board === b.file ? "selected" : ""}`}
            onClick={() => set({ board: b.file })}
          >
            <span className="tile-image" style={{ backgroundImage: `url('./board/${b.file}')` }} />
            <span className="tile-name">{b.name}</span>
          </button>
        ))}
      </div>
      <span className="label">Pezzi</span>
      <div className="chips">
        {PIECE_SETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`chip ${appearance.pieces === p.id ? "selected" : ""}`}
            onClick={() => set({ pieces: p.id })}
          >
            {p.name}
          </button>
        ))}
      </div>
    </div>
  );
}
