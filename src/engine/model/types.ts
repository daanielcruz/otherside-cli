import type { Api, ApiCompatFor } from "@/engine/translator/dispatch/types.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";

export type { EffortLevel };

export type InputModality = "text" | "image" | "pdf" | "audio";

export type ThinkingLevelMap = Partial<Record<EffortLevel, string | number | null>>;

export interface Cost {
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM?: number;
  outputCachedReadPerM?: number;
  thoughtPerM?: number;
  currency: "USD";
}

export interface Model<A extends Api = Api> {
  readonly api: A;
  readonly provider: ProviderId;
  readonly id: string;
  readonly displayName: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly input: readonly InputModality[];
  readonly cost: Cost;
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: ThinkingLevelMap;
  readonly effortLevels: readonly EffortLevel[];
  readonly defaultEffort: EffortLevel | null;
  readonly fastMode?: boolean;
  readonly webSearchKind?: "anthropic-server" | "openai-tool" | "none";
  readonly supports1m?: boolean;
  readonly imageGenOnly?: boolean;
  readonly compat?: ApiCompatFor<A>;
}

export interface ParsedModelId {
  base: string;
  is1m: boolean;
  raw: string;
}

export interface CapabilitySnapshot {
  provider: ProviderId;
  fetchedAt: number;
  models: ReadonlyArray<{
    id: string;
    contextWindow?: number;
    reasoning?: boolean;
    input?: readonly InputModality[];
  }>;
}
