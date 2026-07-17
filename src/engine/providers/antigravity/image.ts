import type {
  ImageGenerationRequest,
  ImageGenerationResult,
} from "@/engine/providers/image-generation.ts";
import { loadConfig } from "@/kernel/config/config.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import { ProviderHttpError } from "@/kernel/std/types/error-meta.ts";
import type { ImageMediaType } from "@/kernel/std/types/image.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";
import { currentTokens, resolveProjectId } from "./auth.ts";
import {
  backendHost,
  buildCloudCodeEnvelope,
  generateContentUrl,
  userAgent,
} from "./fingerprint.ts";
import { refreshAntigravityQuotaWarning } from "./usage.ts";

const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";
const MAX_REFERENCES = 3;
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function isAborted(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function headers(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": userAgent(),
    "Content-Type": "application/json",
    "Accept-Encoding": "gzip",
  };
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  accessToken: string,
  signal?: AbortSignal,
): Promise<unknown> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: headers(accessToken),
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (isAborted(error, signal)) throw new Error("image generation aborted");
    throw error;
  }
  if (resp.status === 401) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `HTTP 401 from antigravity image generation: ${truncateEllipsis(text, 300)} — run \`otherside login --provider antigravity\``,
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new ProviderHttpError({
      provider: "antigravity image generation",
      status: resp.status,
      body: text,
      retryAfterHeader: resp.headers.get("retry-after"),
    });
  }
  try {
    return await resp.json();
  } catch (error) {
    if (isAborted(error, signal)) throw new Error("image generation aborted");
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to decode antigravity image response: ${message}`);
  }
}

function imageModelId(value: unknown): string {
  const root = isRecord(value) ? value : null;
  const ids =
    root && Array.isArray(root.imageGenerationModelIds) ? root.imageGenerationModelIds : [];
  const model = ids.find((id): id is string => typeof id === "string" && id.trim().length > 0);
  if (!model) throw new Error("no Gemini image generation models are available for this account");
  return model;
}

function generatedImage(value: unknown): { base64: string; mediaType: ImageMediaType } {
  const root = isRecord(value) ? value : null;
  const response = root && isRecord(root.response) ? root.response : null;
  const candidates = response && Array.isArray(response.candidates) ? response.candidates : [];
  for (const candidateValue of candidates) {
    const candidate = isRecord(candidateValue) ? candidateValue : null;
    const content = candidate && isRecord(candidate.content) ? candidate.content : null;
    const parts = content && Array.isArray(content.parts) ? content.parts : [];
    for (const partValue of parts) {
      const part = isRecord(partValue) ? partValue : null;
      const inlineData = part && isRecord(part.inlineData) ? part.inlineData : null;
      const mediaType = inlineData?.mimeType;
      const base64 = inlineData?.data;
      if (
        typeof mediaType === "string" &&
        IMAGE_MEDIA_TYPES.has(mediaType) &&
        typeof base64 === "string" &&
        base64.length > 0
      ) {
        return { base64, mediaType: mediaType as ImageMediaType };
      }
    }
  }
  throw new Error("Gemini image generation response contained no supported image");
}

export async function generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const images = req.images ?? [];
  if (images.length > MAX_REFERENCES) {
    throw new Error(`Gemini image generation supports at most ${MAX_REFERENCES} image references`);
  }
  const tokens = await currentTokens();
  const project = await resolveProjectId(tokens);
  const catalog = await postJson(
    `${backendHost()}${FETCH_AVAILABLE_MODELS_PATH}`,
    { project },
    tokens.accessToken,
    req.abortSignal,
  );
  const model = imageModelId(catalog);
  const parts: Record<string, unknown>[] = [{ text: req.prompt }];
  for (const image of images) {
    parts.push({ inlineData: { mimeType: image.mediaType, data: image.data } });
  }
  const config = await loadConfig();
  const envelope = buildCloudCodeEnvelope({
    model,
    project,
    requestId: `image_gen/${crypto.randomUUID()}/${Date.now()}`,
    requestType: "image_gen",
    request: {
      model,
      contents: [{ role: "user", parts }],
    },
    googleOneAi: config.antigravityGoogleOneAi !== false,
  });
  const payload = await postJson(
    generateContentUrl(),
    envelope,
    tokens.accessToken,
    req.abortSignal,
  );
  const result = generatedImage(payload);
  void refreshAntigravityQuotaWarning().catch(() => {});
  return { ...result, callId: crypto.randomUUID() };
}
