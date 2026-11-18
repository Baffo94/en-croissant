import { createFileRoute } from "@tanstack/react-router";
import ScanPage from "@/components/scan/ScanPage";

export const Route = createFileRoute("/scan")({
  component: ScanPage,
});
