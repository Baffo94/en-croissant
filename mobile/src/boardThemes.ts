// Board images and piece sets taken from the desktop app (public/board, public/pieces).

export type BoardTheme = { file: string; name: string; coords: { white: string; black: string } };

export const BOARDS: BoardTheme[] = [
    { file: "gray.svg", name: "Grigia", coords: { white: "#e9ecef", black: "#868e96" } },
    { file: "blue.png", name: "Blu", coords: { white: "#dee3e6", black: "#788a94" } },
    { file: "blue2.jpg", name: "Blu scuro", coords: { white: "#97b2c7", black: "#546f82" } },
    { file: "green.png", name: "Verde", coords: { white: "#ffd", black: "#6d8753" } },
    { file: "olive.jpg", name: "Oliva", coords: { white: "#b8b19f", black: "#6d6655" } },
    { file: "brown.png", name: "Marrone", coords: { white: "#f0d9b5", black: "#946f51" } },
    { file: "wood4.jpg", name: "Legno", coords: { white: "#caaf7d", black: "#7b5330" } },
    { file: "maple.jpg", name: "Acero", coords: { white: "#e8ceab", black: "#bc7944" } },
    { file: "marble.jpg", name: "Marmo", coords: { white: "#93ab91", black: "#4f644e" } },
    { file: "purple.png", name: "Viola", coords: { white: "#9f90b0", black: "#7d4a8d" } },
    { file: "ic.png", name: "IC", coords: { white: "#ececec", black: "#c1c18e" } },
    { file: "newspaper.svg", name: "Giornale", coords: { white: "#fff", black: "#8d8d8d" } },
];

export const PIECE_SETS: { id: string; name: string }[] = [
    { id: "staunty", name: "Staunty" },
    { id: "cburnett", name: "Cburnett" },
    { id: "merida", name: "Merida" },
    { id: "alpha", name: "Alpha" },
    { id: "california", name: "California" },
    { id: "maestro", name: "Maestro" },
    { id: "fresca", name: "Fresca" },
    { id: "kosal", name: "Kosal" },
];

/** Same defaults as the desktop app. */
export const DEFAULT_BOARD = "gray.svg";
export const DEFAULT_PIECES = "staunty";

export function boardTheme(file: string): BoardTheme {
    return BOARDS.find((b) => b.file === file) ?? BOARDS[0];
}

/** Loads the CSS of a piece set (replacing the previous one). */
export function applyPieceSet(id: string) {
    const set = PIECE_SETS.some((p) => p.id === id) ? id : DEFAULT_PIECES;
    let link = document.getElementById("piece-set") as HTMLLinkElement | null;
    if (!link) {
        link = document.createElement("link");
        link.id = "piece-set";
        link.rel = "stylesheet";
        document.head.appendChild(link);
    }
    const href = `./pieces/${set}.css`;
    if (link.getAttribute("href") !== href) link.setAttribute("href", href);
}
