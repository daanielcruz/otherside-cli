import { providerEndpoint } from "@/devtools/config.ts";
import { ProviderHttpError } from "@/engine/providers/_shared/retry.ts";
import type {
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageSize,
} from "@/engine/providers/image-generation.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import { currentTokens } from "./auth.ts";
import { GROK_CLIENT_VERSION } from "./fingerprint.ts";

const IMAGE_MODEL = "grok-imagine-image-quality";
const IMAGES_BASE_URL = providerEndpoint("xai", "images", "https://api.x.ai/v1/images");
const MAX_REFERENCES = 3;

function isAborted(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function aspectRatio(size: ImageSize | undefined): "1:1" | "2:3" | "3:2" {
  if (size === "1024x1536") return "2:3";
  if (size === "1536x1024") return "3:2";
  return "1:1";
}

export async function generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const images = req.images ?? [];
  if (images.length > MAX_REFERENCES) {
    throw new Error(`Grok image generation supports at most ${MAX_REFERENCES} image references`);
  }
  const tokens = await currentTokens();
  const operation = images.length > 0 ? "edits" : "generations";
  const ratio = aspectRatio(req.size);
  const body: Record<string, unknown> = {
    model: IMAGE_MODEL,
    prompt: req.prompt,
    n: 1,
    resolution: "1k",
    response_format: "b64_json",
  };
  if (images.length === 0) {
    body.aspect_ratio = ratio;
  } else {
    const references = images.map((image) => ({
      url: `data:${image.mediaType};base64,${image.data}`,
    }));
    if (references.length === 1) body.image = references[0];
    else {
      body.images = references;
      body.aspect_ratio = ratio;
    }
  }

  let resp: Response;
  try {
    resp = await fetch(`${IMAGES_BASE_URL.replace(/\/$/, "")}/${operation}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "User-Agent": `xai-grok-build/${GROK_CLIENT_VERSION}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
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
      `HTTP 401 from xai /images/${operation}: ${truncateEllipsis(text, 300)} — run \`otherside login --provider xai\``,
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const retryAfterHeader = resp.headers.get("retry-after");
    throw new ProviderHttpError({
      provider: `xai /images/${operation}`,
      status: resp.status,
      body: text,
      retryAfterHeader,
    });
  }

  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (error) {
    if (isAborted(error, req.abortSignal)) throw new Error("image generation aborted");
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to decode xai image ${operation} response: ${message}`);
  }
  const data = (payload as { data?: Array<{ b64_json?: unknown }> } | null)?.data;
  const base64 = data?.[0]?.b64_json;
  if (typeof base64 !== "string" || base64.length === 0) {
    throw new Error(`xai image ${operation} response contained no image`);
  }
  return { base64, mediaType: "image/jpeg", callId: crypto.randomUUID() };
}
