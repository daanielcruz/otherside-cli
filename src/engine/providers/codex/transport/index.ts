import { recordPayloadDiagnostic } from "@/devtools/payload.ts";
import { currentTokens, forceRefreshTokens } from "@/engine/providers/codex/auth.ts";
import { streamHttp } from "@/engine/providers/codex/transport/http.ts";
import {
  forceHttpFallback,
  getTransport,
  incrementWsStreamFailures,
  resetWsStreamFailures,
} from "@/engine/providers/codex/transport/state.ts";
import { streamWs } from "@/engine/providers/codex/transport/ws.ts";
import { CodexWsClosedBeforeCompletionError } from "@/engine/providers/codex/transport/ws-router.ts";
import { CodexWsHandshakeError } from "@/engine/providers/codex/transport/ws-socket-pool.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export { clearSessionState } from "@/engine/providers/codex/transport/state.ts";
export { closeAllSockets } from "@/engine/providers/codex/transport/ws-socket-pool.ts";

function isHandshake401(err: unknown): boolean {
  if (!(err instanceof CodexWsHandshakeError)) return false;
  if (err.message.includes("401")) return true;
  const cause = err.cause;
  if (cause && typeof cause === "object") {
    const status =
      (cause as Record<string, unknown>).statusCode ?? (cause as Record<string, unknown>).status;
    if (status === 401) return true;
  }
  return false;
}

function isWsStreamLevelError(err: unknown): boolean {
  if (err instanceof CodexWsClosedBeforeCompletionError) return true;
  if (err instanceof Error && err.message === "codex ws stream: socket error") return true;
  return false;
}

export async function* stream(
  ctx: RequestContext,
  body: unknown,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  const transportContext = { ...ctx, abortSignal: signal };
  recordPayloadDiagnostic("provider-request", body, {
    toolName: ctx.subagentLabel ? "codex-subagent" : "codex-main",
    toolUseId: ctx.responseRequestId ?? ctx.agentId ?? ctx.turnId ?? ctx.sessionId,
  });
  if (getTransport(ctx.sessionId) === "http") {
    yield* streamHttp(transportContext, body);
    return;
  }
  const initialTokens = await currentTokens().catch(() => null);
  const initialTokenStr = initialTokens?.accessToken ?? "";
  let hasAttemptedWsHandshakeRecovery = false;

  try {
    for await (const chunk of streamWs(transportContext, body)) {
      yield chunk;
    }
    resetWsStreamFailures(ctx.sessionId);
  } catch (err) {
    if (err instanceof CodexWsHandshakeError) {
      const is401 = isHandshake401(err);
      if (is401 && !hasAttemptedWsHandshakeRecovery) {
        hasAttemptedWsHandshakeRecovery = true;
        // Reload first — another flow may have already refreshed; only hit the
        // OAuth endpoint when the stored token is the one the server rejected.
        let newTokens = await currentTokens().catch(() => null);
        if (!newTokens || newTokens.accessToken === initialTokenStr) {
          newTokens = await forceRefreshTokens(initialTokens ?? undefined).catch(() => null);
        }
        if (newTokens && newTokens.accessToken !== initialTokenStr) {
          try {
            for await (const chunk of streamWs(transportContext, body)) {
              yield chunk;
            }
            resetWsStreamFailures(ctx.sessionId);
            return;
          } catch (retryErr) {
            forceHttpFallback(
              ctx.sessionId,
              retryErr instanceof Error ? retryErr.message : String(retryErr),
            );
            yield* streamHttp(transportContext, body);
            return;
          }
        }
      }
      forceHttpFallback(ctx.sessionId, err.message);
      yield* streamHttp(transportContext, body);
      return;
    }

    if (isWsStreamLevelError(err)) {
      const failures = incrementWsStreamFailures(ctx.sessionId);
      if (failures >= 3) {
        forceHttpFallback(
          ctx.sessionId,
          `WS stream failed ${failures} times consecutively: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    throw err;
  }
}
