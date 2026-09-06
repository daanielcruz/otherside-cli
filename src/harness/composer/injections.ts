import type { SkillListingEntry } from "@/harness/reminders/reminders.ts";
import type { OutputStyleRecord } from "@/harness/routines/output-styles/built-in.ts";
import type { CacheControl } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

// The harness declares the config shape it needs (DIP) — the only fields any
// layer reads — instead of importing the engine/kernel-runtime `UserConfig`.
// The engine injects the resolved config, which structurally satisfies this.
export interface HarnessConfig {
  outputStyle?: string;
  language?: string;
  parallelTasks?: boolean;
}

export interface InjectionQueue {
  drain(): string[];
  peek(): readonly string[];
  push(s: string): void;
}

export interface AgentRowData {
  agentType: string;
  whenToUse: string;
  whenToUseLean?: string;
  toolsLabel: string;
}

export interface AvailableModelsRow {
  provider: string;
  models: readonly { id: string; display: string }[];
}

export interface McpInstructionBlock {
  server: string;
  text: string;
}

// Every runtime fact the engine resolves before composing the harness.
// This is the ONLY declaration of these fields: LayerContext derives by
// intersection, BuildHarnessInput carries it whole. Adding a context fact
// = one edit here, one line at the resolve site (assemble.ts).
export interface ResolvedHarnessFacts {
  config: HarnessConfig;
  /** Resolved active output style; null for default and unknown names. */
  outputStyle: OutputStyleRecord | null;
  deferredToolExclusions: ReadonlySet<string>;
  emitDeferredReminder: boolean;
  emitAgentListing: boolean;
  injections: InjectionQueue;
  /** Reminders leave the user turn as system messages (all Anthropic models). */
  promoteMidSystem: boolean;
  /** Promoted reminders drop their wrapper; also latches the mid-system wording. */
  supportsMidSystem: boolean;
  lean: boolean;
  modelFamily: "fable" | "sonnet" | "other";
  availableModels: readonly AvailableModelsRow[];
  knowledgeCutoff: string | null;
  agentRows: readonly AgentRowData[];
  deferredToolNames: readonly string[];
  deferredMcpToolNames: readonly string[];
  memorySection: string | null;
  projectMemorySection: string | null;
  mcpInstructionBlocks: readonly McpInstructionBlock[];
  skillListing: readonly SkillListingEntry[];
  modelDisplayName?: string;
  nestedMemory?: { path: string; content: string }[];
  currentDate?: string;
  gitStatus?: string;
}

export type LayerContext = RequestContext & ResolvedHarnessFacts;

export interface HarnessLayer {
  name: string;
  render(ctx: LayerContext): string | null;
}

export interface SystemTextBlock {
  text: string;
  cache_control?: CacheControl;
  // Only meaningful for layers with kind: 'system' (consumed by Anthropic's
  // consolidateHarnessBlocks to split into static / dynamic cache buckets).
  // Mid-system and user-kind blocks ignore this field.
  phase?: "static" | "dynamic";
  // Header label for the Anthropic prependUserContext-style envelope;
  // populated from CategorizedLayer.bundleKey ?? layer.name during compose().
  bundleKey?: string;
  standalone?: boolean;
}

export type PhasedSystemBlock = SystemTextBlock & { phase?: "static" | "dynamic" };

// How reminder content travels on this request: kept in the user turn, lifted
// to a system message with the reminder wrapper, or lifted without it. The
// provider composer reads it both for the harness blocks and for promoting
// reminder-only user messages born on later turns.
export type MidSystemPromotion = "off" | "wrapped" | "unwrapped";

export interface ComposedHarness {
  layers: { name: string; body: string }[];
  combined: string;
  systemBlocks: SystemTextBlock[];
  userPrepend: SystemTextBlock[];
  midSystemBlocks?: SystemTextBlock[];
  midSystemPromotion: MidSystemPromotion;
}
