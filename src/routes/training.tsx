import { createFileRoute } from "@tanstack/react-router";
import TrainingPage from "@/components/training/TrainingPage";

export const Route = createFileRoute("/training")({
  component: TrainingPage,
});
