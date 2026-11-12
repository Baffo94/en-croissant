import { useState } from "react";
import { ideaPoints, ideasDraft, ideasText } from "@/utils/ideas";
import { useBackHandler } from "../back";
import { getGameComment, setComment } from "../comments";
import { useAppState } from "../state";
import { Header } from "./Practice";

/**
 * The ideas of a section: a list of points written in the PGN as the comment before
 * the first move, like on the PC (where En Croissant shows it at the starting position).
 */
export function Ideas({
  rel,
  game,
  title,
  onBack,
}: {
  rel: string;
  game: number;
  title: string;
  onBack: () => void;
}) {
  useBackHandler(onBack);
  // Re-read when the file changes (a sync, or a save from here).
  const stored = useAppState((s) => (s.files[rel] ? getGameComment(rel, game) : ""));
  const points = ideaPoints(stored);
  const [editing, setEditing] = useState(points.length === 0);
  const [draft, setDraft] = useState(ideasDraft(stored));
  const [error, setError] = useState(false);

  return (
    <div className="screen ideas">
      <Header title={`💡 ${title}`} onBack={onBack} />
      <div className="ideas-body">
        {editing ? (
          <div className="comment-edit">
            <textarea
              rows={10}
              value={draft}
              autoFocus
              placeholder={"Un'idea per riga"}
              onChange={(e) => setDraft(e.target.value)}
            />
            <p className="dim small">
              Un'idea per riga. Si salvano nel PGN come commento prima della prima mossa, come dal
              PC, e si sincronizzano.
            </p>
            {error && <p className="comment-error">Impossibile salvare le idee in questo PGN.</p>}
            <div className="comment-buttons">
              <button type="button" onClick={() => (points.length ? setEditing(false) : onBack())}>
                Annulla
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  if (setComment(rel, game, [], ideasText(draft))) {
                    setEditing(false);
                    setError(false);
                  } else setError(true);
                }}
              >
                Salva
              </button>
            </div>
          </div>
        ) : (
          <>
            <ul className="ideas-list">
              {points.map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: points can repeat
                <li key={i}>{p}</li>
              ))}
            </ul>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setDraft(ideasDraft(stored));
                setEditing(true);
              }}
            >
              ✏️ Modifica
            </button>
          </>
        )}
      </div>
    </div>
  );
}
