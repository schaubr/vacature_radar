import type { ModelId } from "./types";

export const MODELS: { id: ModelId; label: string; note: string }[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "best judgment" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "balanced" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "cheapest" },
];
