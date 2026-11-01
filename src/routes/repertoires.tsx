import { createFileRoute } from "@tanstack/react-router";
import RepertoiresPage from "@/components/repertoires/RepertoiresPage";

export const Route = createFileRoute("/repertoires")({
  component: RepertoiresPage,
  loader: ({ context: { loadDirs } }) => loadDirs(),
});
