import {
  detectQuotaExhaustion,
  ProviderHttpError,
  parseRetryAfterHeader,
} from "@/engine/providers/_shared/retry.ts";
import type {
  ImageGenerationRequest,
  ImageGenerationResult,
} from "@/engine/providers/image-generation.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import { currentTokens, ensureInstallationId } from "./auth.ts";
import { buildHeaders, CHATGPT_BASE_URL } from "./fingerprint.ts";
import { buildCodexRequestMetadata } from "./metadata.ts";

const IMAGE_MODEL = "gpt-image-2";

function isAborted(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

export async function generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const tokens = await currentTokens();
  const ids = await ensureInstallationId();
  const conversationId = crypto.randomUUID();
  const requestMetadata = buildCodexRequestMetadata({
    ctx: { cwd: process.cwd(), permissionMode: "default" },
    installationId: ids.installationId,
    mainSessionId: conversationId,
    mainThreadId: conversationId,
    windowGeneration: 0,
    requestKind: "turn",
  });

  const headers = buildHeaders({
    bearer: `Bearer ${tokens.accessToken}`,
    accountId: tokens.accountId,
    requestMetadata,
    transport: "http",
  });
  headers.Accept = "application/json";

  const images = req.images ?? [];
  const operation = images.length > 0 ? "edits" : "generations";
  const body: Record<string, unknown> = {
    prompt: req.prompt,
    background: "auto",
    model: IMAGE_MODEL,
    quality: "auto",
    size: req.size ?? "1024x1024",
  };
  if (images.length > 0) {
    body.images = images.map((image) => ({
      image_url: `data:${image.mediaType};base64,${image.data}`,
    }));
  }

  let resp: Response;
  try {
    resp = await fetch(`${CHATGPT_BASE_URL}/images/${operation}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(req.abortSignal ? { signal: req.abortSignal } : {}),
    });
  } catch (error) {
    if (isAborted(error, req.abortSignal)) throw new Error("image generation aborted");
    throw error;
  }

  if (resp.status === 401) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `HTTP 401 from codex /images/${operation}: ${truncateEllipsis(text, 300)} — run \`otherside login --provider codex\``,
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const retryAfterHeader = resp.headers.get("retry-after");
    const quota = detectQuotaExhaustion({
      provider: "codex",
      status: resp.status,
      headers: resp.headers,
      body: text,
      retryAfterMs: parseRetryAfterHeader(retryAfterHeader),
    });
    throw new ProviderHttpError({
      provider: `codex /images/${operation}`,
      status: resp.status,
      body: text,
      retryAfterHeader,
      shouldRetryHeader: resp.headers.get("x-should-retry"),
      quotaExhausted: quota.quotaExhausted,
      quotaResetEpochMs: quota.resetEpochMs,
    });
  }

  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (error) {
    if (isAborted(error, req.abortSignal)) throw new Error("image generation aborted");
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to decode image ${operation} response: ${message}`);
  }
  const data = (payload as { data?: Array<{ b64_json?: unknown }> } | null)?.data;
  const base64 = data?.[0]?.b64_json;
  if (typeof base64 !== "string" || base64.length === 0) {
    throw new Error(`codex image ${operation} response contained no image`);
  }

  return { base64, mediaType: "image/png", callId: crypto.randomUUID() };
}
