import { useState } from "react";

export type NoteItem = { label: string; text: string; onSave?: (text: string) => boolean };

/**
 * Comment of a repertoire move. With `onSave` it can be edited (✏️): the text is
 * written in the PGN like a comment typed on the PC.
 */
export function CommentItem({ label, text, onSave }: NoteItem) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState(false);
  if (editing && onSave) {
    return (
      <div className="comment-edit">
        <span className="notes-label">{label}</span>
        <textarea rows={4} value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} />
        {error && <p className="comment-error">Mossa non trovata nel PGN: commento non salvato.</p>}
        <div className="comment-buttons">
          <button type="button" onClick={() => setEditing(false)}>
            Annulla
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              if (onSave(draft)) {
                setEditing(false);
                setError(false);
              } else setError(true);
            }}
          >
            Salva
          </button>
        </div>
      </div>
    );
  }
  return (
    <p>
      <span className="notes-label">{label}</span>{" "}
      {text.trim() ? text : <span className="dim">nessun commento</span>}
      {onSave && (
        <button
          type="button"
          className="comment-edit-btn"
          aria-label={text.trim() ? "Modifica il commento" : "Aggiungi un commento"}
          onClick={() => {
            setDraft(text);
            setEditing(true);
          }}
        >
          ✏️
        </button>
      )}
    </p>
  );
}
