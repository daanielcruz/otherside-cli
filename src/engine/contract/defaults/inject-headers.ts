import type { WireFingerprint } from "@/engine/contract/wire-fingerprint.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export type FingerprintFn = (ctx: RequestContext) => WireFingerprint;

export function defaultInjectHeaders(
  ctx: RequestContext,
  fingerprint: FingerprintFn,
): Record<string, string> {
  const fp = fingerprint(ctx);
  return { "User-Agent": fp.userAgent, ...fp.extraHeaders };
}
