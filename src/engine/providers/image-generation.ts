import type { ImageMediaType } from "@/kernel/std/types/image.ts";
import type {
  ImageGeneratorProviderId,
  ImageGeneratorSelection,
  ProviderId,
} from "@/kernel/std/types/provider-ids.ts";
import { isImageGeneratorProviderId } from "@/kernel/std/types/provider-ids.ts";

export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024";

export interface ImageGenerationInput {
  data: string;
  mediaType: ImageMediaType;
}

export interface ImageGenerationRequest {
  prompt: string;
  size?: ImageSize;
  images?: ImageGenerationInput[];
  abortSignal?: AbortSignal;
}

export interface ImageGenerationResult {
  base64: string;
  mediaType: ImageMediaType;
  callId: string;
}

const LABELS: Record<ImageGeneratorProviderId, string> = {
  codex: "Codex",
  xai: "Grok",
  antigravity: "Gemini",
};

export function imageGeneratorLabel(provider: ImageGeneratorProviderId): string {
  return LABELS[provider];
}

export function resolveImageGeneratorProvider(
  selection: ImageGeneratorSelection | undefined,
  turnProvider: ProviderId | string,
): ImageGeneratorProviderId | null {
  if (selection && selection !== "off") return selection;
  if (selection === "off") return null;
  return isImageGeneratorProviderId(turnProvider) ? turnProvider : null;
}

export async function generateImageWithProvider(
  provider: ImageGeneratorProviderId,
  request: ImageGenerationRequest,
): Promise<ImageGenerationResult> {
  switch (provider) {
    case "codex":
      return (await import("@/engine/providers/codex/image.ts")).generateImage(request);
    case "xai":
      return (await import("@/engine/providers/xai/image.ts")).generateImage(request);
    case "antigravity":
      return (await import("@/engine/providers/antigravity/image.ts")).generateImage(request);
  }
}
