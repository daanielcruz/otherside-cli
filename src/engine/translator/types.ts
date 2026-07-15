import type { ProviderPromptAdapter } from "@/engine/contract/prompt-adapter.ts";
import type { DeferredOverrides } from "@/engine/tools/deferred-overrides.ts";
import type { ComposedHarness, InjectionQueue } from "@/harness/composer/injections.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export interface ProviderToolDeclaration {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  defer_loading?: boolean;
  eager_input_streaming?: boolean;
}

export interface ProviderTurn {
  harness: ComposedHarness;
  messages: Message[];
  tools: ProviderToolDeclaration[];
}

export interface TurnProvider {
  readonly id: ProviderId;
  deferredOverrides(): DeferredOverrides;
  promptAdapter(): ProviderPromptAdapter;
  composeMessages(harness: ComposedHarness, history: Message[]): Message[];
}

export interface AssembleArgs {
  ctx: RequestContext;
  provider: TurnProvider;
  messages: Message[];
  injections: InjectionQueue;
  config: UserConfig;
  currentDate?: string;
  gitStatus?: string;
  nestedMemory?: { path: string; content: string }[];
}
