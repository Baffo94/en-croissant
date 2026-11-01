import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyPieceSet } from "./boardThemes";
import { getState, loadState } from "./state";
import "./styles.css";

loadState().then(() => {
  applyPieceSet(getState().appearance.pieces);
  createRoot(document.getElementById("root")!).render(<App />);
});
