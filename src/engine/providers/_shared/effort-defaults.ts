import type { FallbackEfforts } from "@/engine/contract/feature-flags.ts";
import type { DeferredOverrides } from "@/engine/tools/deferred-overrides.ts";

export const NO_EFFORT_AUTO: FallbackEfforts = {
  levels: [],
  default: null,
};

export const PERMISSIVE_DEFERRED: DeferredOverrides = {
  excludeFromCatalog: [],
  alwaysDeclare: [],
  emitDeferredReminder: true,
};
