import { useState } from "react";
import type { Note } from "@/utils/sync/core";
import { formatLine } from "@/utils/noteLine";
import { liveNotes } from "@/utils/sync/core";
import { deleteNote, editNote, useAppState } from "../state";
import { scheduleSync } from "../sync";

const NOTE_SYNC_DELAY = 5_000;

/** Full-screen sheet to write or edit a note on the last move of `line`. */
export function NoteEditor({
  startFen,
  line,
  initial = "",
  onSave,
  onCancel,
}: {
  startFen: string;
  line: string[];
  initial?: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <div className="note-sheet" role="dialog">
      <div className="note-box">
        <p className="note-title">Nota sulla mossa</p>
        <p className="note-line">{formatLine(startFen, line)}</p>
        <textarea
          autoFocus
          rows={5}
          value={text}
          placeholder="Cosa non ti è chiaro? La rivedrai sul PC."
          onChange={(e) => setText(e.target.value)}
        />
        <p className="small">
          La nota non modifica il repertorio: la trovi sul PC nella pagina Repertori.
        </p>
        <div className="buttons">
          <button type="button" onClick={onCancel}>
            Annulla
          </button>
          <button
            type="button"
            className="primary"
            disabled={!text.trim()}
            onClick={() => {
              onSave(text.trim());
              scheduleSync(NOTE_SYNC_DELAY);
            }}
          >
            Salva
          </button>
        </div>
      </div>
    </div>
  );
}

/** Notes of a repertoire about the position `fen` (i.e. on the move that led there). */
export function NotesHere({ rel, fen }: { rel: string; fen: string }) {
  const notes = useAppState((s) => s.notes?.[rel]);
  const [editing, setEditing] = useState<Note | null>(null);
  const here = liveNotes(notes).filter((n) => n.fen === fen);
  if (here.length === 0 && !editing) return null;
  return (
    <div className="my-notes">
      {here.map((n) => (
        <div key={n.id} className="my-note">
          <p className="my-note-head">📝 {formatLine(n.startFen, n.line)}</p>
          <p className="my-note-text">{n.text}</p>
          <div className="my-note-actions">
            <button type="button" onClick={() => setEditing(n)}>
              Modifica
            </button>
            <button
              type="button"
              onClick={() => {
                deleteNote(rel, n.id);
                scheduleSync(NOTE_SYNC_DELAY);
              }}
            >
              Elimina
            </button>
          </div>
        </div>
      ))}
      {editing && (
        <NoteEditor
          startFen={editing.startFen}
          line={editing.line}
          initial={editing.text}
          onCancel={() => setEditing(null)}
          onSave={(text) => {
            editNote(rel, editing.id, text);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
