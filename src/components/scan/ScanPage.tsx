import {
  Alert,
  Box,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconChess,
  IconClipboard,
  IconPhoto,
  IconRotate,
  IconZoomCheck,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { parseSquare, type Piece, type SquareName } from "chessops";
import { makeFen, parseFen } from "chessops/fen";
import { useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, type ScannedBoard } from "@/bindings";
import { Chessground } from "@/chessground/Chessground";
import PiecesGrid from "@/components/boards/PiecesGrid";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { createTab } from "@/utils/tabs";
import { defaultTree } from "@/utils/treeReducer";
import {
  boardFen,
  castlingFor,
  doubtfulSquares,
  IMAGE_EXTENSIONS,
  positionProblem,
  rotated,
} from "./scan";
import classes from "./ScanPage.module.css";

type Scan = {
  /** Shown on the left: a blob/asset URL. */
  src: string;
  width: number;
  height: number;
  boards: ScannedBoard[];
};

export default function ScanPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setTabs = useSetAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const boardRef = useRef<HTMLDivElement>(null);

  const [scan, setScan] = useState<Scan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState(0);
  /** The position being checked: placement only (the board shows it as recognised, then edited). */
  const [placement, setPlacement] = useState<string | null>(null);
  const [doubtful, setDoubtful] = useState<SquareName[]>([]);
  const [turn, setTurn] = useState<"white" | "black">("white");
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [selectedPiece, setSelectedPiece] = useState<Piece | null>(null);

  const choose = useCallback((boards: ScannedBoard[], index: number) => {
    const board = boards[index];
    setChosen(index);
    setSelectedPiece(null);
    if (!board) {
      setPlacement(null);
      setDoubtful([]);
      return;
    }
    const placement = boardFen(board.squares);
    setPlacement(placement);
    setDoubtful(doubtfulSquares(board));
    // A side in check is the one to move (a diagram after a check).
    setTurn(
      positionProblem(`${placement} w ${castlingFor(placement)} - 0 1`) === "OppositeCheck"
        ? "black"
        : "white",
    );
    // Show it as in the diagram: Black at the bottom when it was so.
    setOrientation(board.flipped ? "black" : "white");
  }, []);

  const run = useCallback(
    async (input: { path: string } | { data: string }, src: string) => {
      setBusy(true);
      setError("");
      try {
        const result = await commands.scanBoardImage(
          "path" in input ? input.path : null,
          "data" in input ? input.data : null,
        );
        if (result.status === "error") throw new Error(result.error);
        setScan({ src, ...result.data });
        choose(result.data.boards, 0);
        if (result.data.boards.length === 0) setError(t("Scan.NoBoard"));
      } catch (e) {
        setScan(null);
        setPlacement(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [choose, t],
  );

  const fromBlob = useCallback(
    (blob: Blob) => {
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result);
        void run({ data }, data);
      };
      reader.readAsDataURL(blob);
    },
    [run],
  );

  const fromPath = useCallback((path: string) => void run({ path }, convertFileSrc(path)), [run]);

  // Ctrl+V anywhere on the page.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const item = [...(event.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      const blob = item?.getAsFile();
      if (blob) {
        event.preventDefault();
        fromBlob(blob);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [fromBlob]);

  // Image files dropped on the window.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const path = event.payload.paths.find((p) =>
          IMAGE_EXTENSIONS.includes(p.split(".").pop()?.toLowerCase() ?? ""),
        );
        if (path) fromPath(path);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [fromPath]);

  async function pickFile() {
    const selected = await open({
      multiple: false,
      filters: [{ name: t("Scan.Images"), extensions: IMAGE_EXTENSIONS }],
    });
    if (typeof selected === "string") fromPath(selected);
  }

  async function pasteButton() {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((x) => x.startsWith("image/"));
        if (type) return fromBlob(await item.getType(type));
      }
      setError(t("Scan.NoImageInClipboard"));
    } catch {
      setError(t("Scan.NoImageInClipboard"));
    }
  }

  const fen = placement
    ? `${placement} ${turn === "white" ? "w" : "b"} ${castlingFor(placement)} - 0 1`
    : null;
  const problem = fen ? positionProblem(fen) : null;

  async function openAs(type: "analysis" | "play") {
    if (!fen || problem) return;
    const headers = { ...defaultTree(fen).headers, fen, orientation };
    await createTab({
      tab: { name: t(type === "play" ? "Scan.PlayTabName" : "Scan.TabName"), type },
      setTabs,
      setActiveTab,
      pgn: "*",
      headers: type === "play" ? { ...headers, result: "*" as const, start: [] } : headers,
    });
    navigate({ to: "/" });
  }

  const edit = (next: string) => {
    setPlacement(next.split(" ")[0]);
    // Squares changed by hand are no longer in doubt.
    setDoubtful((d) =>
      d.filter((sq) => pieceAt(next, sq) === pieceAt(`${placement} w - - 0 1`, sq)),
    );
  };

  const board = scan?.boards[chosen];

  return (
    <Stack h="100%" gap={0}>
      <div style={{ padding: "var(--mantine-spacing-lg) var(--mantine-spacing-lg) 0" }}>
        <Title order={2}>{t("Scan.Title")}</Title>
        <Text c="dimmed" size="sm">
          {t("Scan.Subtitle")}
        </Text>
      </div>
      <ScrollArea flex={1} p="lg">
        <Group align="flex-start" gap="xl" wrap="wrap">
          <Stack gap="sm" className={classes.source}>
            <Group gap="xs">
              <Button leftSection={<IconClipboard size="1rem" />} onClick={pasteButton}>
                {t("Scan.Paste")}
              </Button>
              <Button variant="default" leftSection={<IconPhoto size="1rem" />} onClick={pickFile}>
                {t("Scan.Open")}
              </Button>
            </Group>
            <Paper withBorder className={classes.drop} p={scan ? 0 : "xl"}>
              {busy ? (
                <Center h={240}>
                  <Loader />
                </Center>
              ) : scan ? (
                <Box className={classes.preview}>
                  <img src={scan.src} alt="" />
                  {scan.boards.length > 1 &&
                    scan.boards.map((b, i) => (
                      <button
                        // biome-ignore lint/suspicious/noArrayIndexKey: boards have no id
                        key={i}
                        type="button"
                        className={classes.box}
                        data-active={i === chosen || undefined}
                        style={{
                          left: `${(b.x / scan.width) * 100}%`,
                          top: `${(b.y / scan.height) * 100}%`,
                          width: `${(b.width / scan.width) * 100}%`,
                          height: `${(b.height / scan.height) * 100}%`,
                        }}
                        onClick={() => choose(scan.boards, i)}
                        aria-label={t("Scan.ChooseBoard", { n: i + 1 })}
                      >
                        <span>{i + 1}</span>
                      </button>
                    ))}
                </Box>
              ) : (
                <Center h={200}>
                  <Text c="dimmed" ta="center" size="sm">
                    {t("Scan.Empty")}
                  </Text>
                </Center>
              )}
            </Paper>
            {scan && scan.boards.length > 1 && (
              <Text size="sm" c="dimmed">
                {t("Scan.SeveralBoards", { count: scan.boards.length })}
              </Text>
            )}
            {error && (
              <Alert color="red" icon={<IconAlertTriangle size="1rem" />}>
                {error}
              </Alert>
            )}
          </Stack>

          {placement && board && (
            <Stack gap="sm" className={classes.check}>
              <Text fw={600}>{t("Scan.Check")}</Text>
              <Text size="sm" c="dimmed">
                {doubtful.length > 0
                  ? t("Scan.Doubtful", { count: doubtful.length })
                  : t("Scan.CheckHelp")}
              </Text>
              <Group align="flex-start" gap="md" wrap="nowrap">
                <Box ref={boardRef} className={classes.board}>
                  <Chessground
                    fen={`${placement} w - - 0 1`}
                    orientation={orientation}
                    coordinates
                    animation={{ enabled: false }}
                    movable={{ free: true, color: "both", showDests: false }}
                    draggable={{ enabled: true, deleteOnDropOff: true }}
                    selectable={{ enabled: true }}
                    drawable={{ enabled: false, visible: false }}
                    highlight={{
                      lastMove: false,
                      check: false,
                      custom: new Map(doubtful.map((sq) => [sq, classes.doubt])),
                    }}
                    events={{
                      select: (key) => {
                        if (!selectedPiece) return;
                        const setup = parseFen(`${placement} w - - 0 1`);
                        const square = parseSquare(key as SquareName);
                        if (setup.isErr || square === undefined) return;
                        setup.value.board.set(square, selectedPiece);
                        edit(makeFen(setup.value));
                      },
                    }}
                    setBoardFen={edit}
                  />
                </Box>
                <Stack gap="sm" className={classes.side}>
                  <PiecesGrid
                    fen={`${placement} w - - 0 1`}
                    boardRef={boardRef}
                    orientation={orientation}
                    onPut={(next) => {
                      edit(next);
                      setSelectedPiece(null);
                    }}
                    selectedPiece={selectedPiece}
                    onSelectPiece={setSelectedPiece}
                  />
                  <div>
                    <Text size="sm" fw={500} mb={4}>
                      {t("Scan.ToMove")}
                    </Text>
                    <SegmentedControl
                      fullWidth
                      value={turn}
                      onChange={(v) => setTurn(v as "white" | "black")}
                      data={[
                        { label: t("Scan.White"), value: "white" },
                        { label: t("Scan.Black"), value: "black" },
                      ]}
                    />
                  </div>
                  <Button
                    variant="default"
                    size="xs"
                    leftSection={<IconRotate size="1rem" />}
                    onClick={() => {
                      // The diagram was read the wrong way round: turn the position.
                      setPlacement(rotated(placement));
                      setDoubtful((d) => d.map(rotateSquare));
                      setOrientation((o) => (o === "white" ? "black" : "white"));
                    }}
                  >
                    {t("Scan.Rotate")}
                  </Button>
                </Stack>
              </Group>
              {problem && (
                <Alert color="orange" icon={<IconAlertTriangle size="1rem" />}>
                  {
                    {
                      Invalid: t("Scan.Problem.Invalid"),
                      Empty: t("Scan.Problem.Empty"),
                      Kings: t("Scan.Problem.Kings"),
                      PawnsOnBackrank: t("Scan.Problem.PawnsOnBackrank"),
                      OppositeCheck: t("Scan.Problem.OppositeCheck"),
                    }[problem]
                  }
                </Alert>
              )}
              <Group gap="sm">
                <Button
                  leftSection={<IconZoomCheck size="1rem" />}
                  disabled={!!problem}
                  onClick={() => openAs("analysis")}
                >
                  {t("Scan.Analyze")}
                </Button>
                <Button
                  variant="light"
                  leftSection={<IconChess size="1rem" />}
                  disabled={!!problem}
                  onClick={() => openAs("play")}
                >
                  {t("Scan.Play")}
                </Button>
              </Group>
            </Stack>
          )}
        </Group>
      </ScrollArea>
    </Stack>
  );
}

function pieceAt(fen: string, square: SquareName): string {
  const setup = parseFen(fen);
  const sq = parseSquare(square);
  if (setup.isErr || sq === undefined) return "";
  const piece = setup.value.board.get(sq);
  return piece ? `${piece.color}${piece.role}` : "";
}

function rotateSquare(sq: SquareName): SquareName {
  const file = "abcdefgh"["abcdefgh".length - 1 - "abcdefgh".indexOf(sq[0])];
  const rank = 9 - Number(sq[1]);
  return `${file}${rank}` as SquareName;
}
