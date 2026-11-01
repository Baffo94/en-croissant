import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The app reuses pure modules of the desktop app (../src): PGN parsing, practice
// decks and GitHub sync. Shared packages are deduped so that both sides use the
// copies installed here.
export default defineConfig({
    base: "./",
    plugins: [react()],
    resolve: {
        alias: {
            "@": resolve(import.meta.dirname, "../src"),
            // Pulled in by ../src/utils/misc.ts but never used on mobile.
            "@tauri-apps/plugin-fs": resolve(import.meta.dirname, "src/stubs/tauri-fs.ts"),
        },
        dedupe: [
            "react",
            "react-dom",
            "chessops",
            "ts-fsrs",
            "zod",
            "ts-pattern",
            "@lichess-org/chessground",
        ],
    },
    server: { fs: { allow: [".."] } },
    build: { outDir: "dist", emptyOutDir: true },
});
