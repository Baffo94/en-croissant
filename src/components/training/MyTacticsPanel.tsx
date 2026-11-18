import {
  Alert,
  Badge,
  Button,
  Card,
  Chip,
  Group,
  Loader,
  ScrollArea,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import {
  IconArrowRight,
  IconBookmarkPlus,
  IconCheck,
  IconEye,
  IconFileText,
  IconPlayerPlay,
  IconX,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { parseUci } from "chessops";
import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import { useAtom, useSetAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { commands } from "@/bindings";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { createTab } from "@/utils/tabs";
import {
  type Attempt,
  answer,
  fenAfter,
  giveUp,
  type MyTactic,
  moveSquares,
  newAttempt,
  type SolutionPart,
  selectTactics,
  shuffled,
  solutionParts,
  TACTICS_FILE_TYPE,
  tagsOf,
} from "@/utils/training/myTactics";
import { listCollections } from "@/utils/training/tacticsFiles";
import { unwrap } from "@/utils/unwrap";
import { TrainingBoard } from "./TrainingBoard";
import classes from "./training.module.css";

/** Last result of each tactic on this device: right first time or not. */
type Results = Record<string, { ok: boolean; at: number }>;
const resultsAtom = atomWithStorage<Results>("my-tactics-results", {}, undefined, {
  getOnInit: true,
});
const choiceAtom = atomWithStorage(
  "my-tactics-choice",
  {
    collections: [] as string[],
    tags: [] as string[],
    order: "book" as "book" | "random",
    onlyWrong: false,
  },
  undefined,
  { getOnInit: true },
);

function useOpenTactic() {
  const setTabs = useSetAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const navigate = useNavigate();
  return async (tactic: MyTactic) => {
    const [pgns, count] = await Promise.all([
      commands.readGames(tactic.file, tactic.game, tactic.game),
      commands.countPgnGames(tactic.file),
    ]);
    await createTab({
      tab: { name: tactic.collection, type: "analysis" },
      setTabs,
      setActiveTab,
      pgn: unwrap(pgns)[0] ?? "",
      gameOrigin: {
        kind: "file",
        gameNumber: tactic.game,
        file: {
          type: "file",
          name: tactic.collection,
          path: tactic.file,
          numGames: unwrap(count),
          metadata: { type: TACTICS_FILE_TYPE, tags: [] },
          lastModified: Date.now(),
        },
      },
    });
    navigate({ to: "/" });
  };
}

export function MyTacticsPanel() {
  const { t } = useTranslation();
  const { data: collections, isLoading } = useSWR("tactic-collections", listCollections);
  const [choice, setChoice] = useAtom(choiceAtom);
  const [results] = useAtom(resultsAtom);
  const [session, setSession] = useState<MyTactic[] | null>(null);

  const all = useMemo(() => (collections ?? []).flatMap((c) => c.tactics), [collections]);
  const names = (collections ?? []).map((c) => c.name);
  // Choices that no longer exist (a renamed collection, a tag removed) are ignored.
  const chosenCollections = choice.collections.filter((c) => names.includes(c));
  const inCollections = selectTactics(all, chosenCollections, []);
  const tags = tagsOf(inCollections);
  const chosenTags = choice.tags.filter((tag) =>
    tags.some((x) => x.toLowerCase() === tag.toLowerCase()),
  );
  const selected = selectTactics(inCollections, [], chosenTags).filter(
    (x) => !choice.onlyWrong || results[x.id]?.ok !== true,
  );

  if (session) return <MyTacticSession tactics={session} onDone={() => setSession(null)} />;
  if (isLoading) return <Loader />;

  if (all.length === 0) {
    return (
      <Card withBorder p="xl">
        <Stack align="center" gap="sm" maw={620} mx="auto">
          <IconBookmarkPlus size="2rem" />
          <Text ta="center">{t("Training.MyTactics.Empty")}</Text>
        </Stack>
      </Card>
    );
  }

  const tagCount = (tag: string) =>
    inCollections.filter((x) => x.tags.some((y) => y.toLowerCase() === tag.toLowerCase())).length;

  return (
    <Stack gap="md">
      <Text c="dimmed" size="sm">
        {t("Training.MyTactics.Intro")}
      </Text>
      <div>
        <Text fw={600} mb={6}>
          {t("Training.MyTactics.Collections")}
        </Text>
        <Chip.Group
          multiple
          value={chosenCollections}
          onChange={(v) => setChoice({ ...choice, collections: v })}
        >
          <Group gap="xs">
            {(collections ?? []).map((c) => (
              <Chip key={c.path} value={c.name}>
                {c.name} · {c.tactics.length}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
        <Text size="xs" c="dimmed" mt={4}>
          {t("Training.MyTactics.CollectionsHelp")}
        </Text>
      </div>
      {tags.length > 0 && (
        <div>
          <Text fw={600} mb={6}>
            {t("Training.MyTactics.Tags")}
          </Text>
          <Chip.Group
            multiple
            value={chosenTags}
            onChange={(v) => setChoice({ ...choice, tags: v })}
          >
            <Group gap="xs">
              {tags.map((tag) => (
                <Chip key={tag} value={tag} size="sm" variant="light">
                  {tag} · {tagCount(tag)}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
          <Text size="xs" c="dimmed" mt={4}>
            {t("Training.MyTactics.TagsHelp")}
          </Text>
        </div>
      )}
      <Group gap="lg" align="center">
        <SegmentedControl
          value={choice.order}
          onChange={(v) => setChoice({ ...choice, order: v as "book" | "random" })}
          data={[
            { label: t("Training.MyTactics.InOrder"), value: "book" },
            { label: t("Training.MyTactics.Shuffled"), value: "random" },
          ]}
        />
        <Switch
          checked={choice.onlyWrong}
          onChange={(e) => setChoice({ ...choice, onlyWrong: e.currentTarget.checked })}
          label={t("Training.MyTactics.OnlyWrong")}
        />
      </Group>
      <Group>
        <Button
          leftSection={<IconPlayerPlay size="1rem" />}
          disabled={selected.length === 0}
          onClick={() => setSession(choice.order === "random" ? shuffled(selected) : selected)}
        >
          {t("Training.MyTactics.Start", { count: selected.length })}
        </Button>
        <Text size="sm" c="dimmed">
          {t("Training.MyTactics.Stats", {
            right: selected.filter((x) => results[x.id]?.ok === true).length,
            wrong: selected.filter((x) => results[x.id]?.ok === false).length,
            fresh: selected.filter((x) => !results[x.id]).length,
          })}
        </Text>
      </Group>
      <Text size="xs" c="dimmed">
        {t("Training.MyTactics.EditNote")}
      </Text>
    </Stack>
  );
}

function sanOf(fen: string, uci: string): string {
  const pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
  const move = parseUci(uci);
  return move ? makeSan(pos, move) : uci;
}

function MyTacticSession({ tactics, onDone }: { tactics: MyTactic[]; onDone: () => void }) {
  const { t } = useTranslation();
  const [, setResults] = useAtom(resultsAtom);
  const openTactic = useOpenTactic();
  const [index, setIndex] = useState(0);
  const [attempt, setAttempt] = useState<Attempt>(newAttempt);
  /** Moves of the solution on the board (behind `attempt.ply` while the reply is coming). */
  const [shown, setShown] = useState(0);
  /** A position of the solution chosen to look at, once the tactic is over. */
  const [looking, setLooking] = useState<string | null>(null);
  const [score, setScore] = useState({ right: 0, done: 0 });
  const tactic = tactics[index];

  // The reply comes a moment after your move.
  useEffect(() => {
    if (shown >= attempt.ply) return;
    const id = setTimeout(() => setShown(attempt.ply), 450);
    return () => clearTimeout(id);
  }, [shown, attempt.ply]);

  if (!tactic) {
    return (
      <Card withBorder p="xl">
        <Stack align="center">
          <Title order={3}>{t("Training.MyTactics.Done")}</Title>
          <Text>{t("Training.MyTactics.Score", { right: score.right, done: score.done })}</Text>
          <Button onClick={onDone}>{t("Training.Back")}</Button>
        </Stack>
      </Card>
    );
  }

  const over = attempt.state !== "playing";
  const finish = (next: Attempt) => {
    if (next.state === "playing") return;
    const ok = next.state === "solved" && !next.missed;
    setResults((r) => ({ ...r, [tactic.id]: { ok, at: Date.now() } }));
    setScore((s) => ({ right: s.right + (ok ? 1 : 0), done: s.done + 1 }));
  };

  const play = (uci: string) => {
    if (over || shown !== attempt.ply) return;
    const san = sanOf(fenAfter(tactic, attempt.ply), uci);
    const next = answer(tactic, attempt, san);
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
  const lastMove = looking ? undefined : shown > 0 ? moveSquares(tactic, shown) : undefined;
  const side = t(`Training.Side.${tactic.color}`);

  return (
    <Group align="stretch" wrap="nowrap" gap="lg" h="100%">
      <div className={classes.boardArea}>
        <TrainingBoard
          fen={fen}
          orientation={tactic.color}
          movable={!over && !looking && shown === attempt.ply}
          onMove={play}
          lastMove={lastMove}
        />
      </div>
      <Stack w={360} gap="sm">
        <Group gap="xs">
          <Badge variant="light">{tactic.collection}</Badge>
          {tactic.tags.map((tag) => (
            <Badge key={tag} variant="outline" color="gray">
              {tag}
            </Badge>
          ))}
        </Group>
        <Text size="sm" c="dimmed">
          {t("Training.MyTactics.Progress", { n: index + 1, total: tactics.length })}
        </Text>
        <Text fw={600}>{t("Training.MyTactics.Find", { side })}</Text>

        {!over && attempt.misses > 0 && (
          <Alert color="orange" icon={<IconX />}>
            {t("Training.MyTactics.TryAgain")}
          </Alert>
        )}
        {!over && attempt.ply > 0 && attempt.misses === 0 && (
          <Text size="sm" c="green">
            {t("Training.MyTactics.GoOn")}
          </Text>
        )}
        {attempt.state === "solved" && (
          <Alert color={attempt.missed ? "yellow" : "green"} icon={<IconCheck />}>
            {attempt.missed
              ? t("Training.MyTactics.SolvedAfterMiss")
              : t("Training.MyTactics.Solved")}
          </Alert>
        )}
        {attempt.state === "failed" && (
          <Alert color="red" icon={<IconX />}>
            {t("Training.MyTactics.Failed")}
          </Alert>
        )}

        {over && (
          <Card withBorder p="sm">
            <Text size="xs" c="dimmed" mb={4}>
              {t("Training.MyTactics.Solution")}
            </Text>
            <ScrollArea.Autosize mah={260}>
              <Solution
                parts={solutionParts(tactic.root)}
                current={looking}
                onPick={(f) => setLooking(f === looking ? null : f)}
              />
            </ScrollArea.Autosize>
          </Card>
        )}

        <Group gap="xs">
          {!over && (
            <Button variant="default" leftSection={<IconEye size="1rem" />} onClick={showSolution}>
              {t("Training.MyTactics.ShowSolution")}
            </Button>
          )}
          {over && (
            <Button rightSection={<IconArrowRight size="1rem" />} onClick={next}>
              {t("Training.Next")}
            </Button>
          )}
          {over && (
            <Button
              variant="subtle"
              leftSection={<IconFileText size="1rem" />}
              onClick={() => openTactic(tactic)}
            >
              {t("Training.MyTactics.OpenInAnalysis")}
            </Button>
          )}
        </Group>
        <Button variant="subtle" color="gray" mt="auto" onClick={onDone}>
          {t("Training.Stop")}
        </Button>
      </Stack>
    </Group>
  );
}

/** Moves (clickable: the board shows the position), comments and variations. */
function Solution({
  parts,
  current,
  onPick,
  nested = false,
}: {
  parts: SolutionPart[];
  current: string | null;
  onPick: (fen: string) => void;
  nested?: boolean;
}) {
  return (
    <Text size="sm" component={nested ? "span" : "div"} style={{ lineHeight: 1.7 }}>
      {parts.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parts have no id
        <Fragment key={i}>
          {p.kind === "move" && (
            <UnstyledButton
              onClick={() => onPick(p.fen)}
              px={3}
              style={{
                borderRadius: 4,
                fontWeight: p.main ? 700 : 400,
                background: current === p.fen ? "var(--mantine-color-blue-light)" : undefined,
              }}
            >
              {p.label && <span style={{ opacity: 0.6 }}>{p.label}</span>}
              {p.san}
            </UnstyledButton>
          )}
          {p.kind === "comment" && (
            <Text span size="sm" c="dimmed" fs="italic" mx={3}>
              {p.text}
            </Text>
          )}
          {p.kind === "variation" && (
            <Text span size="sm" c="dimmed">
              {" ("}
              <Solution parts={p.parts} current={current} onPick={onPick} nested />
              {") "}
            </Text>
          )}{" "}
        </Fragment>
      ))}
    </Text>
  );
}
