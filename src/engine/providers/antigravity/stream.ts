import {
  authorizationHeader,
  currentTokens,
  resolveProjectId,
} from "@/engine/providers/antigravity/auth.ts";
import {
  buildCloudCodeEnvelope,
  buildInferenceHeaders,
  buildRequestId,
  streamGenerateContentUrl,
} from "@/engine/providers/antigravity/fingerprint.ts";
import { resolveAntigravityModel } from "@/engine/providers/antigravity/models.ts";
import { trajectoryStepCount, turnIds } from "@/engine/providers/antigravity/turn.ts";
import { refreshAntigravityQuotaWarning } from "@/engine/providers/antigravity/usage.ts";
import type { StreamFn } from "@/engine/transport/_infra/classify/types.ts";
import {
  collectErrorBody,
  type Http1Response,
  sendChunkedRequest,
} from "@/engine/transport/http1-socket.ts";
import { loadConfig } from "@/kernel/config/config.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import { ProviderHttpError } from "@/kernel/std/types/error-meta.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

function isRequestBody(body: unknown): body is Record<string, unknown> {
  return Boolean(body) && typeof body === "object" && !Array.isArray(body);
}

function headerLinesFrom(headers: Record<string, string>): string[] {
  return Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
}

async function rejectStatus(res: Http1Response): Promise<void> {
  if (res.status === 401) {
    const text = await collectErrorBody(res.body).catch(() => "");
    throw new Error(
      `HTTP 401 from antigravity: ${truncateEllipsis(text, 300)} — re-run \`otherside login --provider antigravity\``,
    );
  }
  if (res.status === 429) {
    const text = await collectErrorBody(res.body).catch(() => "");
    const ra = res.headers.get("retry-after") ?? null;
    throw new ProviderHttpError({
      provider: "antigravity",
      status: 429,
      body: text,
      retryAfterHeader: ra,
    });
  }
  if (res.status < 200 || res.status >= 300) {
    const text = await collectErrorBody(res.body).catch(() => "");
    throw new ProviderHttpError({ provider: "antigravity", status: res.status, body: text });
  }
}

export const antigravityStream: StreamFn = async function* antigravityStreamFn(
  ctx: RequestContext,
  body: unknown,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  const tokens = await currentTokens();
  const project = await resolveProjectId(tokens);
  const bearer = await authorizationHeader();
  const config = await loadConfig();

  const request = isRequestBody(body) ? body : {};
  const ids = turnIds(ctx.sessionId, ctx.agentOwnerId);
  const envelope = buildCloudCodeEnvelope({
    model: resolveAntigravityModel(ctx.model, ctx.effort).wireModel,
    project,
    requestId: buildRequestId({
      conversationId: ids.conversationId,
      trajectoryId: ids.trajectoryId,
      turn: trajectoryStepCount(request) + 1,
    }),
    request,
    googleOneAi: config.antigravityGoogleOneAi !== false,
  });

  const res = await sendChunkedRequest({
    url: new URL(streamGenerateContentUrl()),
    headerLines: headerLinesFrom(buildInferenceHeaders({ bearer })),
    payload: Buffer.from(JSON.stringify(envelope), "utf8"),
    abortSignal: signal,
  });

  await rejectStatus(res);
  yield* res.body;
  void refreshAntigravityQuotaWarning(ctx.model).catch(() => {});
};
