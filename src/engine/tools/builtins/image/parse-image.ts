import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute } from "node:path";
import {
  NON_VISION_IMAGE_PLACEHOLDER,
  nativeVisionModel,
} from "@/engine/model/facts/capabilities.ts";
import { canSendNatively, resolveParserModel } from "@/engine/model/facts/capabilities-runtime.ts";
import { QuotaExhaustedError } from "@/engine/providers/_shared/retry.ts";
import * as providers from "@/engine/providers/registry.ts";
import { streamWithRetry } from "@/engine/transport/_infra/classify/retry.ts";
import { loadConfig } from "@/kernel/config/config.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import type { ImageMediaType } from "@/kernel/std/types/image.ts";
import type { ContentBlock, Message, ToolResultContentBlock } from "@/kernel/std/types/message.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const SYSTEM_PROMPT = `You are a vision side-channel for a non-vision LLM. The upstream consumer cannot see images and depends on your description as the source of truth — be exhaustive and exact.

Cover, in this order:
1. Overall layout and visual context (what kind of image it is: screenshot, photo, diagram, chart, document).
2. Every line of visible text, verbatim. Preserve casing, punctuation, line breaks. Do not paraphrase. Code and error messages must be character-perfect inside fenced code blocks.
3. UI structure when relevant — windows, panels, buttons, menus, cursors, focus states, indicators.
4. Visual data — colors, shapes, arrangement — only when load-bearing for understanding.
5. Anything notable the upstream model would otherwise miss.

Do NOT add disclaimers, do NOT add interpretation that wasn't asked for, do NOT skip text because it's long. If the image is unreadable, say so explicitly.`;

const DEFAULT_VISION_QUERY = "Describe everything visible in this image in full detail.";

export function mediaTypeFromExt(path: string): ImageMediaType | null {
  const ext = extname(path).slice(1).toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return null;
}

export interface LoadedImage {
  data: string;
  mediaType: ImageMediaType;
}

export function loadImageFromDisk(
  path: string,
  limitBytes: number = 20 * 1024 * 1024,
): LoadedImage | string {
  if (!isAbsolute(path)) return "path must be absolute";
  if (!existsSync(path)) return `image not found: ${path}`;
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return `cannot stat image: ${path}`;
  }
  if (size > limitBytes)
    return `image too large: ${size} bytes (max ${Math.floor(limitBytes / (1024 * 1024))}MB)`;
  const mediaType = mediaTypeFromExt(path);
  if (!mediaType) return `unsupported image extension: ${extname(path) || "(none)"}`;
  try {
    const data = readFileSync(path).toString("base64");
    return { data, mediaType };
  } catch (e) {
    return `cannot read image: ${(e as Error).message}`;
  }
}

function selfParseModel(provider: ProviderId, activeModel: string): string {
  if (canSendNatively(provider, activeModel)) return activeModel;
  return nativeVisionModel(provider) ?? activeModel;
}

export async function describeImageViaProvider(
  ctx: RequestContext,
  image: LoadedImage,
  question: string,
  parserProviderOverride?: ProviderId,
): Promise<{ text: string; visionModel: string } | { error: string }> {
  const cfg = await loadConfig();
  let parserProvider = parserProviderOverride;
  if (!parserProvider) {
    if (nativeVisionModel(ctx.provider) || canSendNatively(ctx.provider)) {
      parserProvider = ctx.provider;
    } else if (cfg.imageParserProvider) {
      parserProvider = cfg.imageParserProvider as ProviderId;
    } else {
      return {
        error:
          "no image parser provider configured. Open /config and set `imageParserProvider` to a vision-capable provider.",
      };
    }
  }

  if (!nativeVisionModel(parserProvider) && !canSendNatively(parserProvider)) {
    return { error: `provider \`${parserProvider}\` is not vision-capable` };
  }

  const usingActive = parserProvider === ctx.provider;
  const parserModel = usingActive
    ? selfParseModel(parserProvider, ctx.model)
    : typeof cfg.imageParserModel === "string" && cfg.imageParserModel.length > 0
      ? cfg.imageParserModel
      : resolveParserModel(parserProvider);
  if (!parserModel) {
    return { error: `cannot resolve a vision model for \`${parserProvider}\`` };
  }

  let provider: ReturnType<typeof providers.get> | null = null;
  try {
    provider = providers.get(parserProvider);
  } catch {
    return { error: `provider \`${parserProvider}\` is not registered` };
  }

  const userPrompt = question.trim().length > 0 ? question.trim() : DEFAULT_VISION_QUERY;
  const messages: Message[] = [
    { role: "system", content: [{ type: "text", text: SYSTEM_PROMPT }] },
    {
      role: "user",
      content: [
        { type: "text", text: userPrompt },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: image.mediaType,
            data: image.data,
          },
        },
      ],
    },
  ];

  const parserCtx: RequestContext = {
    ...ctx,
    provider: parserProvider,
    model: parserModel,
    sessionId: `${ctx.sessionId}/parse-image-${uuidv4().slice(0, 8)}`,
    effort: null,
    agentic: false,
  };

  let body: unknown;
  try {
    body = provider.translateRequest(parserCtx, messages, []);
  } catch (e) {
    return { error: `parser translateRequest failed: ${(e as Error).message}` };
  }

  let text = "";
  let stopReason = "";
  try {
    for await (const event of streamWithRetry(parserCtx, provider, body)) {
      if (event.kind === "text_delta") text += event.text;
      else if (event.kind === "stream_reset") {
        text = "";
        stopReason = "";
      } else if (event.kind === "message_stop") stopReason = event.stop_reason;
      else if (event.kind === "error") {
        return { error: `parser error: ${event.error}` };
      } else if (event.kind === "quota_exhausted") {
        throw new QuotaExhaustedError({
          provider: event.provider,
          model: event.model,
          resetEpochMs: event.resetEpochMs,
          message: event.message,
        });
      }
    }
  } catch (e) {
    if (e instanceof QuotaExhaustedError) throw e;
    return { error: `parser stream failed: ${(e as Error).message}` };
  }

  if (text.trim().length === 0) {
    const why = stopReason ? ` (stop_reason=${stopReason})` : "";
    return { error: `parser returned empty description${why}` };
  }

  return { text, visionModel: parserModel };
}

export async function resolveImagesForNonVision(
  blocks: ContentBlock[],
  ctx: RequestContext,
  parserProvider: ProviderId,
  imagePasteIds: number[],
): Promise<ContentBlock[]> {
  const out: ContentBlock[] = [];
  let imageIdx = 0;
  for (const block of blocks) {
    if (block.type !== "image") {
      out.push(block);
      continue;
    }
    const pasteId = imagePasteIds[imageIdx];
    imageIdx += 1;
    const tag = pasteId !== undefined ? `[Image #${pasteId}]` : "[Image]";
    const result = await describeImageViaProvider(
      ctx,
      { data: block.source.data, mediaType: block.source.media_type },
      "",
      parserProvider,
    );
    if ("error" in result) {
      out.push({
        type: "text",
        text: `${tag} (vision dispatch failed: ${result.error})`,
      });
    } else {
      out.push({ type: "text", text: `${tag}\n${result.text}` });
    }
  }
  return out;
}

export function canReplayToolResultImagesNatively(ctx: RequestContext): boolean {
  return ctx.provider !== "glm" && canSendNatively(ctx.provider, ctx.model);
}

export async function resolveToolResultImagesForNonVision(
  ctx: RequestContext,
  blocks: ToolResultContentBlock[],
): Promise<ToolResultContentBlock[]> {
  if (canReplayToolResultImagesNatively(ctx)) {
    return blocks;
  }

  let changed = false;
  const nextBlocks: ToolResultContentBlock[] = [];

  for (const block of blocks) {
    if (block.type === "image") {
      changed = true;
      nextBlocks.push({ type: "text", text: await describeOrRedact(ctx, block) });
    } else {
      nextBlocks.push(block);
    }
  }

  return changed ? nextBlocks : blocks;
}

// Ingestion must never throw: a quota-exhausted parser (rethrown by
// describeImageViaProvider) would otherwise escape the tool loop and drop
// already-drained queued user messages. Degrade to the placeholder instead.
async function describeOrRedact(
  ctx: RequestContext,
  block: Extract<ToolResultContentBlock, { type: "image" }>,
): Promise<string> {
  try {
    const result = await describeImageViaProvider(
      ctx,
      { data: block.source.data, mediaType: block.source.media_type },
      "",
    );
    if ("error" in result) return NON_VISION_IMAGE_PLACEHOLDER;
    return `[Image]\n${result.text}`;
  } catch {
    return NON_VISION_IMAGE_PLACEHOLDER;
  }
}
