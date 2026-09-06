import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export type StreamFn = (
  ctx: RequestContext,
  body: unknown,
  signal: AbortSignal,
) => AsyncIterable<Uint8Array>;

export type DecodeFn = (raw: AsyncIterable<Uint8Array>) => AsyncIterable<ProviderEvent>;

export interface StreamRetryDecision {
  readonly retry: boolean;
  readonly delayMs?: number;
  readonly reason?: string;
}
