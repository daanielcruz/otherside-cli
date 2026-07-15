import type { AuthStrategy } from "@/engine/contract/auth.ts";
import type { FallbackEfforts, ProviderFeatureFlags } from "@/engine/contract/feature-flags.ts";
import type { LoginFlow } from "@/engine/contract/login.ts";
import type { ProviderPromptAdapter } from "@/engine/contract/prompt-adapter.ts";
import type { WireFingerprint } from "@/engine/contract/wire-fingerprint.ts";
import type { ModelEntry } from "@/engine/model/catalog.ts";
import type { Model } from "@/engine/model/types.ts";
import type { WebSearchInput, WebSearchPayload } from "@/engine/tools/common.ts";
import type { DeferredOverrides } from "@/engine/tools/deferred-overrides.ts";
import type { Api } from "@/engine/translator/dispatch/types.ts";
import type { RetryDecision } from "@/engine/transport/_infra/classify/retry.ts";
import type { ComposedHarness } from "@/harness/composer/injections.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export interface UsageDetails {
  sourceLabel: string;
  hasPlanPanel?: boolean;
}

export type { AuthCredentials, AuthStrategy } from "@/engine/contract/auth.ts";
export type { WireFingerprint } from "@/engine/contract/wire-fingerprint.ts";
export type { RetryDecision } from "@/engine/transport/_infra/classify/retry.ts";

export type ApiProviderSourceId = "builtin" | "user" | "extension";

export interface ApiProvider<A extends Api> {
  readonly id: ProviderId;
  readonly api: A;
  readonly sourceId: ApiProviderSourceId;
  readonly label: string;
  readonly shortKey: string;
}

export interface ProviderAuthSnapshot {
  raw: unknown;
}

export interface ProviderConfig<A extends Api> {
  readonly provider: ApiProvider<A>;
  readonly models?: readonly Model<A>[];
  readonly legacyModels?: readonly ModelEntry[] | (() => readonly ModelEntry[]);
  readonly asyncFactory?: (deps: ProviderFactoryDeps) => Promise<readonly Model<A>[]>;
  readonly modifyModels?: (
    models: readonly Model<A>[],
    auth: ProviderAuthSnapshot,
  ) => readonly Model<A>[];

  readonly auth?: AuthStrategy;
  readonly signupHint?: string;
  readonly featureFlags?: ProviderFeatureFlags;
  readonly modelAvailable?: (modelId: string) => boolean;
  readonly defaultModelId?: string | (() => string);
  readonly fallbackEfforts?: FallbackEfforts;
  readonly allowsCustomModel?: boolean;
  readonly fingerprint?: (ctx: RequestContext) => WireFingerprint;
  readonly translateRequest?: (
    ctx: RequestContext,
    messages: Message[],
    tools: unknown[],
  ) => unknown;
  readonly translateResponse?: (raw: AsyncIterable<Uint8Array>) => AsyncIterable<ProviderEvent>;
  readonly stream?: (ctx: RequestContext, body: unknown) => AsyncIterable<Uint8Array>;
  readonly deferredOverrides?: DeferredOverrides;
  readonly promptAdapter?: ProviderPromptAdapter;
  readonly recoverableError?: (
    err: unknown,
    ctx: RequestContext,
    attempt?: number,
  ) => RetryDecision;
  readonly getResumeBody?: (ctx: RequestContext, originalBody: unknown) => unknown | null;
  readonly webSearch?: (input: WebSearchInput, ctx: RequestContext) => Promise<WebSearchPayload>;
  readonly usageDetails?: UsageDetails;
  readonly beginLogin?: LoginFlow;
  readonly composeMessages?: (harness: ComposedHarness, history: Message[]) => Message[];
  readonly applyTrailingCacheControl?: (messages: Message[]) => Message[];
  readonly composeForkSystem?: (input: ForkSystemInput) => ContentBlock[];
  readonly composeForkUserBlock?: (prompt: string) => ContentBlock;
  readonly onCompactionSucceeded?: (ctx: RequestContext) => void;
  readonly streamEmitsKeepalive?: boolean;
  // Content-progress deadline override for providers whose healthy streams can stay event-silent longer than the default (they must carry their own transport-level stall protection).
  readonly contentIdleTimeoutMs?: number;
}

export interface ForkSystemInput {
  name: string;
  body: string;
  firstPrompt: string;
  previousRequestId?: string;
  /** Folded notes + runtime environment tail for the single cached block. */
  envTail?: string;
}

export interface ProviderFactoryDeps {
  credentials: unknown;
}

export interface Provider {
  readonly id: ProviderId;
  readonly auth: AuthStrategy;
  readonly label: string;
  readonly shortKey: string;
  readonly signupHint?: string;

  featureFlags(): ProviderFeatureFlags;
  modelAvailable(modelId: string): boolean;
  defaultModelId(): string;
  fallbackEfforts(): FallbackEfforts;
  allowsCustomModel(): boolean;

  fingerprint(ctx: RequestContext): WireFingerprint;
  injectHeaders(ctx: RequestContext): Record<string, string>;

  translateRequest(ctx: RequestContext, messages: Message[], tools: unknown[]): unknown;
  translateResponse(raw: AsyncIterable<Uint8Array>): AsyncIterable<ProviderEvent>;
  stream(ctx: RequestContext, body: unknown): AsyncIterable<Uint8Array>;
  getResumeBody?(ctx: RequestContext, originalBody: unknown): unknown | null;

  defaultModels(): ModelEntry[];
  deferredOverrides(): DeferredOverrides;
  promptAdapter(): ProviderPromptAdapter;
  recoverableError(err: unknown, ctx: RequestContext, attempt?: number): RetryDecision;

  webSearch?(input: WebSearchInput, ctx: RequestContext): Promise<WebSearchPayload>;
  usageDetails?(): UsageDetails;
  beginLogin(): LoginFlow;
  composeForkSystem(input: ForkSystemInput): ContentBlock[];
  composeForkUserBlock(prompt: string): ContentBlock;
  composeMessages(harness: ComposedHarness, history: Message[]): Message[];
  applyTrailingCacheControl?(messages: Message[]): Message[];
  onCompactionSucceeded?(ctx: RequestContext): void;
}
