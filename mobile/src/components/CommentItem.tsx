import { useState } from "react";
import type { FlagProps } from "../reviewFlags";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

export type NoteItem = {
  label: string;
  text: string;
  /** Saves the comment in the PGN (like a comment typed on the PC); absent = read only. */
  onSave?: (text: string) => boolean;
  /** Flag "to review on the PC" of the move. */
  flag?: FlagProps;
  /** The move is not in the repertoire (analysis): no comment, only the flag. */
  outside?: boolean;
};

/**
 * A move with its comment and its flag "to review". The actions sit together in the
 * header (comment, flag); editing happens in a sheet from the bottom.
 */
export function CommentItem({ label, text, onSave, flag, outside }: NoteItem) {
  const [sheet, setSheet] = useState<"comment" | "flag" | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState(false);
  const flagged = flag?.flag;

  const openComment = () => {
    setDraft(text);
    setError(false);
    setSheet("comment");
  };
  const openFlag = () => {
    setDraft(flagged?.text ?? "");
    setSheet("flag");
  };

  return (
    <div className="note-item">
      <div className="note-head">
        <span className="notes-label">{label}</span>
        {(onSave || flag) && (
          <span className="note-actions">
            {onSave && (
              <button
                type="button"
                className="icon-btn"
                aria-label={text.trim() ? "Modifica il commento" : "Aggiungi un commento"}
                onClick={openComment}
              >
                <Icon name="message" size={18} />
              </button>
            )}
            {flag && (
              <button
                type="button"
                className={`icon-btn${flagged ? " danger" : ""}`}
                aria-label={flagged ? "Segnalazione da rivedere" : "Segnala da rivedere sul PC"}
                onClick={openFlag}
              >
                <Icon name="flag" size={18} />
              </button>
            )}
          </span>
        )}
      </div>
      {outside ? (
        <p className="note-text dim">Mossa fuori dal repertorio</p>
      ) : text.trim() ? (
        <p className="note-text">{text}</p>
      ) : (
        <p className="note-text dim">Nessun commento</p>
      )}
      {flagged && (
        <button type="button" className="note-flag" onClick={openFlag}>
          <strong>Da rivedere</strong> · {flagged.text}
        </button>
      )}

      {sheet === "comment" && onSave && (
        <Sheet title={`Commento · ${label}`} onClose={() => setSheet(null)}>
          <textarea
            className="sheet-text"
            rows={4}
            value={draft}
            autoFocus
            placeholder="Il tuo commento alla mossa"
            onChange={(e) => setDraft(e.target.value)}
          />
          {error && (
            <p className="comment-error">Mossa non trovata nel PGN: commento non salvato.</p>
          )}
          <div className="sheet-buttons">
            <span />
            <button
              type="button"
              className="primary"
              onClick={() => {
                if (onSave(draft)) setSheet(null);
                else setError(true);
              }}
            >
              Salva
            </button>
          </div>
        </Sheet>
      )}

      {sheet === "flag" && flag && (
        <Sheet title={`Da rivedere · ${label}`} onClose={() => setSheet(null)}>
          <p className="sheet-hint">
            Sul PC la ritrovi in Repertori → Da rivedere, con un tasto per aprire la posizione.
          </p>
          <textarea
            className="sheet-text"
            rows={3}
            value={draft}
            autoFocus
            placeholder="Cosa non ti convince? Meglio Dd2?"
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="sheet-buttons">
            {flagged ? (
              <button
                type="button"
                className="with-icon"
                onClick={() => {
                  flag.onSave("");
                  setSheet(null);
                }}
              >
                <Icon name="check" size={18} /> Risolta
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              className="primary"
              disabled={!draft.trim()}
              onClick={() => {
                flag.onSave(draft);
                setSheet(null);
              }}
            >
              {flagged ? "Salva" : "Segnala"}
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
