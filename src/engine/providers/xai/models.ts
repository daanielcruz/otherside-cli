import type { ModelEntry } from "@/engine/model/catalog.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";

// SoT for grok's roster. Ids, windows, and reasoning-effort support come from
// `grok models` + `~/.grok/models_cache.json` on a live SuperGrok account.
// grok-4.5 is the reasoning flagship; grok-composer-2.5-fast is the fast coding
// model and does NOT accept the reasoning/effort parameters.
export const GROK_MODELS: readonly ModelEntry[] = [
  {
    id: "grok-4.5",
    displayName: "Grok 4.5",
    contextWindow: 500_000,
    autoCompactTokenLimit: 467_000,
    provider: "xai",
    efforts: ["low", "medium", "high"],
    defaultEffort: "high",
  },
  {
    id: "grok-composer-2.5-fast",
    displayName: "Grok Composer 2.5 Fast",
    contextWindow: 200_000,
    autoCompactTokenLimit: 167_000,
    provider: "xai",
    efforts: [],
    defaultEffort: null,
  },
];

// Whether a model accepts the `reasoning` object (summary/effort) and the
// `reasoning.encrypted_content` include. The chat proxy 400s a reasoning param
// on a non-reasoning model, so this gates both at request-build time.
export function modelSupportsReasoning(modelId: string): boolean {
  const entry = GROK_MODELS.find((m) => m.id === modelId);
  // Unknown ids (custom) default to reasoning-on: the flagship path, and the
  // proxy tolerates reasoning on reasoning-capable models.
  return entry ? entry.efforts.length > 0 : true;
}

// The chat proxy rejects `reasoning_effort: "none"` for grok-4.5 — the model has
// no way to fully disable reasoning. When a turn asks to suppress thinking, we
// approximate "off" with the model's cheapest real effort. Returns the lowest
// listed effort, defaulting to "low" for unknown (custom) reasoning ids.
export function lowestReasoningEffort(modelId: string): EffortLevel | null {
  const entry = GROK_MODELS.find((m) => m.id === modelId);
  if (!entry) return "low";
  return entry.efforts[0] ?? null;
}
