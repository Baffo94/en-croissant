import { useState } from "react";
import type { FlagProps } from "../reviewFlags";

/**
 * Flag "to review on the PC" of a move: a note that the PC lists in Repertori → Da
 * rivedere, so that doubtful moves are not forgotten in a comment.
 */
export function FlagItem({ flag, onSave }: FlagProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (editing) {
    return (
      <div className="comment-edit flag-edit">
        <span className="notes-label">🚩 Da rivedere sul PC</span>
        <textarea
          rows={3}
          value={draft}
          autoFocus
          placeholder="Cosa non ti convince? (es. Meglio Dd2?)"
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="comment-buttons">
          <button type="button" onClick={() => setEditing(false)}>
            Annulla
          </button>
          <button
            type="button"
            className="primary"
            disabled={!draft.trim()}
            onClick={() => {
              onSave(draft);
              setEditing(false);
            }}
          >
            Segnala
          </button>
        </div>
      </div>
    );
  }
  if (!flag) {
    return (
      <button
        type="button"
        className="flag-add"
        onClick={() => {
          setDraft("");
          setEditing(true);
        }}
      >
        🚩 Segnala da rivedere
      </button>
    );
  }
  return (
    <div className="flag-open">
      <span>
        🚩 <strong>Da rivedere:</strong> {flag.text}
      </span>
      <span className="flag-actions">
        <button
          type="button"
          aria-label="Modifica la segnalazione"
          onClick={() => {
            setDraft(flag.text);
            setEditing(true);
          }}
        >
          ✏️
        </button>
        <button type="button" onClick={() => onSave("")}>
          ✓ Risolta
        </button>
      </span>
    </div>
  );
}
