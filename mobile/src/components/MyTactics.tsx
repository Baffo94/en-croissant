import { makeSan } from "chessops/san";
import type { NormalMove } from "chessops";
import { Fragment, useEffect, useMemo, useState } from "react";
import { positionFromFen } from "@/utils/chessops";
import {
  type Attempt,
  answer,
  fenAfter,
  giveUp,
  type MyTactic,
  moveSquares,
  newAttempt,
  parseCollection,
  type SolutionPart,
  selectTactics,
  shuffled,
  solutionParts,
  TACTICS_FILE_TYPE,
  TACTICS_FOLDER,
  tagsOf,
} from "@/utils/training/myTactics";
import { readText } from "../comments";
import { useAppState } from "../state";
import { Board } from "./Board";
import { Header } from "./Practice";

type Results = Record<string, { ok: boolean; at: number }>;
const RESULTS_KEY = "my-tactics-results";
const CHOICE_KEY = "my-tactics-choice";
type Choice = {
  collections: string[];
  tags: string[];
  order: "book" | "random";
  onlyWrong: boolean;
};

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable: the choice is not remembered.
  }
}

const sideName = (c: "white" | "black") => (c === "white" ? "il Bianco" : "il Nero");

/** The collections synced from the PC: "Tattiche/<name>.pgn" of type "tactics". */
export function useCollections(): { name: string; tactics: MyTactic[] }[] {
  const files = useAppState((s) => s.files);
  return useMemo(() => {
    const prefix = `${TACTICS_FOLDER}/`.toLowerCase();
    const out: { name: string; tactics: MyTactic[] }[] = [];
    for (const rel of Object.keys(files).sort()) {
      if (!rel.toLowerCase().startsWith(prefix) || !rel.toLowerCase().endsWith(".pgn")) continue;
      if (rel.slice(prefix.length).includes("/")) continue;
      const info = readText(rel.replace(/\.pgn$/i, ".info"));
      try {
        if (info && JSON.parse(info).type !== TACTICS_FILE_TYPE) continue;
      } catch {
        // An unreadable .info: still a collection, by its folder.
      }
      const name = rel.slice(prefix.length).replace(/\.pgn$/i, "");
      const text = readText(rel);
      out.push({ name, tactics: text ? parseCollection(text, name, rel) : [] });
    }
    return out;
  }, [files]);
}

export function MyTactics({ onBack }: { onBack: () => void }) {
  const collections = useCollections();
  const [choice, setChoiceState] = useState<Choice>(() =>
    load(CHOICE_KEY, { collections: [], tags: [], order: "book", onlyWrong: false }),
  );
  const [results, setResultsState] = useState<Results>(() => load(RESULTS_KEY, {}));
  const [session, setSession] = useState<MyTactic[] | null>(null);
  const setChoice = (c: Choice) => {
    setChoiceState(c);
    save(CHOICE_KEY, c);
  };
  const setResult = (id: string, ok: boolean) =>
    setResultsState((r) => {
      const next = { ...r, [id]: { ok, at: Date.now() } };
      save(RESULTS_KEY, next);
      return next;
    });

  const all = collections.flatMap((c) => c.tactics);
  const names = collections.map((c) => c.name);
  const chosenCollections = choice.collections.filter((c) => names.includes(c));
  const inCollections = selectTactics(all, chosenCollections, []);
  const tags = tagsOf(inCollections);
  const chosenTags = choice.tags.filter((t) =>
    tags.some((x) => x.toLowerCase() === t.toLowerCase()),
  );
  const selected = selectTactics(inCollections, [], chosenTags).filter(
    (x) => !choice.onlyWrong || results[x.id]?.ok !== true,
  );
  const toggle = (list: string[], item: string) =>
    list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

  if (session)
    return <Session tactics={session} onResult={setResult} onBack={() => setSession(null)} />;

  return (
    <div className="screen">
      <Header title="Le mie tattiche" onBack={onBack} />
      {all.length === 0 ? (
        <div className="empty">
          <p>Nessuna tattica salvata.</p>
          <p className="small">
            Si salvano sul PC: da una scheda di analisi, «Salva come tattica». Poi sincronizza.
          </p>
        </div>
      ) : (
        <div className="panel my-tactics">
          <h3 className="section-title">Collezioni</h3>
          <div className="chips">
            {collections.map((c) => (
              <button
                key={c.name}
                type="button"
                className={`chip${chosenCollections.includes(c.name) ? " selected" : ""}`}
                onClick={() =>
                  setChoice({ ...choice, collections: toggle(chosenCollections, c.name) })
                }
              >
                {c.name} · {c.tactics.length}
              </button>
            ))}
          </div>
          <p className="small">Nessuna scelta: tutte.</p>
          {tags.length > 0 && (
            <>
              <h3 className="section-title">Tag</h3>
              <div className="chips">
                {tags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={`chip${chosenTags.includes(tag) ? " selected" : ""}`}
                    onClick={() => setChoice({ ...choice, tags: toggle(chosenTags, tag) })}
                  >
                    {tag}
                  </button>
                ))}
              </div>
              <p className="small">Più tag: le tattiche che li hanno tutti.</p>
            </>
          )}
          <div className="segmented">
            <button
              type="button"
              className={choice.order === "book" ? "active" : ""}
              onClick={() => setChoice({ ...choice, order: "book" })}
            >
              In ordine
            </button>
            <button
              type="button"
              className={choice.order === "random" ? "active" : ""}
              onClick={() => setChoice({ ...choice, order: "random" })}
            >
              Mescolate
            </button>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={choice.onlyWrong}
              onChange={(e) => setChoice({ ...choice, onlyWrong: e.target.checked })}
            />
            Solo quelle non risolte l'ultima volta
          </label>
          <div className="buttons">
            <button
              type="button"
              className="primary"
              disabled={selected.length === 0}
              onClick={() => setSession(choice.order === "random" ? shuffled(selected) : selected)}
            >
              Inizia ({selected.length})
            </button>
          </div>
          <p className="small">
            L'ultima volta: {selected.filter((x) => results[x.id]?.ok === true).length} giuste,{" "}
            {selected.filter((x) => results[x.id]?.ok === false).length} sbagliate,{" "}
            {selected.filter((x) => !results[x.id]).length} mai provate.
          </p>
        </div>
      )}
    </div>
  );
}

function Session({
  tactics,
  onResult,
  onBack,
}: {
  tactics: MyTactic[];
  onResult: (id: string, ok: boolean) => void;
  onBack: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [attempt, setAttempt] = useState<Attempt>(newAttempt);
  const [shown, setShown] = useState(0);
  const [looking, setLooking] = useState<string | null>(null);
  const [score, setScore] = useState({ right: 0, done: 0 });
  const tactic = tactics[index];

  useEffect(() => {
    if (shown >= attempt.ply) return;
    const id = setTimeout(() => setShown(attempt.ply), 450);
    return () => clearTimeout(id);
  }, [shown, attempt.ply]);

  if (!tactic) {
    return (
      <div className="screen practice">
        <Header title="Le mie tattiche" onBack={onBack} />
        <div className="panel">
          <div className="done">
            <p>
              Sessione finita: {score.right} giuste al primo colpo su {score.done}.
            </p>
            <div className="buttons">
              <button type="button" className="primary" onClick={onBack}>
                Torna indietro
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const over = attempt.state !== "playing";
  const finish = (next: Attempt) => {
    if (next.state === "playing") return;
    const ok = next.state === "solved" && !next.missed;
    onResult(tactic.id, ok);
    setScore((s) => ({ right: s.right + (ok ? 1 : 0), done: s.done + 1 }));
  };

  const onMove = (raw: NormalMove) => {
    if (over || shown !== attempt.ply) return;
    const fen = fenAfter(tactic, attempt.ply);
    const [pos] = positionFromFen(fen);
    if (!pos) return;
    const rank = Math.floor(raw.to / 8);
    const move =
      pos.board.get(raw.from)?.role === "pawn" && (rank === 0 || rank === 7)
        ? { ...raw, promotion: "queen" as const }
        : raw;
    if (!pos.isLegal(move)) return;
    const next = answer(tactic, attempt, makeSan(pos, move));
    if (next.ply > attempt.ply) setShown(attempt.ply + 1);
    setAttempt(next);
    finish(next);
  };

  const showSolution = () => {
    const next = giveUp(attempt);
    setAttempt(next);
    finish(next);
  };

  const next = () => {
    setIndex((i) => i + 1);
    setAttempt(newAttempt());
    setShown(0);
    setLooking(null);
  };

  const fen = looking ?? fenAfter(tactic, shown);

  return (
    <div className="screen practice">
      <Header title={tactic.collection} onBack={onBack} />
      <div className="stats-row">
        {tactic.tags.map((tag) => (
          <span key={tag} className="pill">
            {tag}
          </span>
        ))}
        <span className="pill">
          {index + 1} di {tactics.length}
        </span>
      </div>
      <Board
        // The board is rebuilt for a new tactic or a wrong move (back to the position).
        key={`${tactic.id}-${attempt.ply}-${attempt.misses}`}
        fen={fen}
        orientation={tactic.color}
        lastMove={looking ? undefined : shown > 0 ? moveSquares(tactic, shown) : undefined}
        interactive={!over && !looking && shown === attempt.ply}
        onMove={onMove}
      />
      <div className="panel">
        <p className="hint">Muove {sideName(tactic.color)}: trova la mossa migliore.</p>
        {!over && attempt.misses > 0 && (
          <div className="result wrong">
            <p>No. Riprova, oppure guarda la soluzione.</p>
          </div>
        )}
        {!over && attempt.ply > 0 && attempt.misses === 0 && (
          <p className="small">Giusto, continua.</p>
        )}
        {attempt.state === "solved" && (
          <div className={`result ${attempt.missed ? "wrong" : "right"}`}>
            <p>
              {attempt.missed ? "Risolta, ma dopo un errore: conta come sbagliata." : "Risolta!"}
            </p>
          </div>
        )}
        {attempt.state === "failed" && (
          <div className="result wrong">
            <p>Ecco la soluzione.</p>
          </div>
        )}
        {over && (
          <div className="solution">
            <p className="small">Tocca una mossa per vederla sulla scacchiera.</p>
            <Solution
              parts={solutionParts(tactic.root)}
              current={looking}
              onPick={(f) => setLooking(f === looking ? null : f)}
            />
          </div>
        )}
        <div className="buttons">
          {!over && (
            <button type="button" onClick={showSolution}>
              Mostra soluzione
            </button>
          )}
          {over && (
            <button type="button" className="primary" onClick={next}>
              Avanti
            </button>
          )}
        </div>
        <p className="session">
          Sessione: {score.right} giuste · {score.done - score.right} sbagliate
        </p>
      </div>
    </div>
  );
}

function Solution({
  parts,
  current,
  onPick,
}: {
  parts: SolutionPart[];
  current: string | null;
  onPick: (fen: string) => void;
}) {
  return (
    <>
      {parts.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parts have no id
        <Fragment key={i}>
          {p.kind === "move" && (
            <button
              type="button"
              className={`sol-move${p.main ? " main" : ""}${current === p.fen ? " current" : ""}`}
              onClick={() => onPick(p.fen)}
            >
              {p.label && <span className="num">{p.label}</span>}
              {p.san}
            </button>
          )}
          {p.kind === "comment" && <span className="sol-comment">{p.text}</span>}
          {p.kind === "variation" && (
            <span className="sol-variation">
              ( <Solution parts={p.parts} current={current} onPick={onPick} /> )
            </span>
          )}{" "}
        </Fragment>
      ))}
    </>
  );
}
