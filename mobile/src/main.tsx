import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadState } from "./state";
import "./styles.css";

loadState().then(() => {
  createRoot(document.getElementById("root")!).render(<App />);
});
