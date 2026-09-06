import type { EffortLevel } from "@/kernel/std/types/effort.ts";

export interface ProviderFeatureFlags {
  fastMode?: boolean;
  thinkingSuffix?: boolean;
  supportsImages?: boolean;
  // Reasoning summaries stream as sections opening with a bare bold headline
  // (`**Headline**`); enables the strip-and-promote-to-spinner treatment.
  reasoningHeadlines?: boolean;
}

export interface FallbackEfforts {
  levels: EffortLevel[];
  default: EffortLevel | null;
}
