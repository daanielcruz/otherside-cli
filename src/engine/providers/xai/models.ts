import type { ModelEntry } from "@/engine/model/catalog.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";

// SoT for Grok's roster. Ids, windows, and reasoning-effort support come from
// `xai-org/grok-build` `default_models.json` and the live `grok models` roster.
// grok-4.6 is the reasoning flagship (adds wire-level `xhigh`); grok-4.5 stays
// selectable; grok-composer-2.5-fast is the fast coding model and does NOT
// accept the reasoning/effort parameters.
export const GROK_MODELS: readonly ModelEntry[] = [
  {
    id: "grok-4.6",
    displayName: "Grok 4.6",
    contextWindow: 500_000,
    autoCompactTokenLimit: 467_000,
    provider: "xai",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "high",
  },
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

// Wire effort is never `max` — that name is otherside-only and folds here.
export type GrokWireEffort = Exclude<EffortLevel, "max">;

// The chat proxy rejects `reasoning_effort: "none"` on the reasoning flagships —
// they have no way to fully disable reasoning. When a turn asks to suppress
// thinking, we approximate "off" with the model's cheapest real effort. Returns
// the lowest listed effort, defaulting to "low" for unknown (custom) reasoning ids.
export function lowestReasoningEffort(modelId: string): GrokWireEffort | null {
  const entry = GROK_MODELS.find((m) => m.id === modelId);
  if (!entry) return "low";
  const lowest = entry.efforts[0];
  return lowest && lowest !== "max" ? lowest : null;
}

// Highest effort the model lists. Used when the session asks for `max` (an
// otherside-only tier the wire never names) or for an effort the model lacks.
export function highestReasoningEffort(modelId: string): GrokWireEffort | null {
  const entry = GROK_MODELS.find((m) => m.id === modelId);
  if (!entry || entry.efforts.length === 0) return null;
  const highest = entry.efforts[entry.efforts.length - 1];
  return highest && highest !== "max" ? highest : null;
}

export function modelListsEffort(modelId: string, effort: EffortLevel): boolean {
  const entry = GROK_MODELS.find((m) => m.id === modelId);
  if (!entry) {
    // Unknown reasoning ids accept the common four, not max (max is never wire).
    return effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh";
  }
  return entry.efforts.includes(effort);
}
