import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";

export type ProviderVisionKind = "vision" | "hybrid" | "none";

export const PROVIDER_VISION: Record<ProviderId, ProviderVisionKind> = {
  anthropic: "vision",
  antigravity: "vision",
  codex: "vision",
  kimi: "vision",
  glm: "vision",
  xai: "hybrid",
  minimax: "hybrid",
  deepseek: "none",
  openai: "none",
};

const NATIVE_VISION_MODELS: Partial<Record<ProviderId, readonly string[]>> = {
  glm: ["glm-5.2"],
};

const HYBRID_PARSER_MODELS: Partial<Record<ProviderId, string>> = {
  minimax: "minimax-m3",
  xai: "grok-4.6",
};

export function isVisionCapable(provider: ProviderId, model?: string): boolean {
  switch (PROVIDER_VISION[provider]) {
    case "vision": {
      const modelAllowlist = NATIVE_VISION_MODELS[provider];
      return modelAllowlist === undefined || model === undefined || modelAllowlist.includes(model);
    }
    case "none":
      return false;
    case "hybrid":
      return model !== undefined && HYBRID_PARSER_MODELS[provider] === model;
  }
}

export function visionParserModel(provider: ProviderId): string | undefined {
  return HYBRID_PARSER_MODELS[provider];
}

export function nativeVisionModel(provider: ProviderId): string | null {
  return visionParserModel(provider) ?? null;
}

export function canAutoRoute(provider: ProviderId): boolean {
  return PROVIDER_VISION[provider] === "hybrid";
}

export const NON_VISION_IMAGE_PLACEHOLDER =
  "[image redacted: active model cannot read images and no vision parser is configured.]";

export function stripNonVisionImages(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (!messageHasImage(message)) return message;
    const next: ContentBlock[] = [];
    for (const block of message.content) {
      if (block.type === "image") {
        next.push({ type: "text", text: NON_VISION_IMAGE_PLACEHOLDER });
      } else if (block.type === "tool_result" && Array.isArray(block.content)) {
        const content = block.content.map((part) =>
          part.type === "image"
            ? ({ type: "text", text: NON_VISION_IMAGE_PLACEHOLDER } as const)
            : part,
        );
        next.push({ ...block, content });
      } else {
        next.push(block);
      }
    }
    return { ...message, content: next };
  });
}

export function messageHasImage(message: Message): boolean {
  for (const block of message.content) {
    if (block.type === "image") return true;
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      if (block.content.some((part) => part.type === "image")) return true;
    }
  }
  return false;
}
