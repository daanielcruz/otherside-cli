import {
  type ImageRequestPolicy,
  imageRequestPolicyFor,
} from "@/engine/contract/image-request-policy.ts";
import {
  compressImageToBudget,
  ImageCompressError,
  readImageDimensions,
  resizeImageIfTooLarge,
} from "@/kernel/std/image-resize.ts";
import type { ImageDimensions } from "@/kernel/std/types/image.ts";
import type { ContentBlock, Message, ToolResultContentBlock } from "@/kernel/std/types/message.ts";
import type { ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";

type DirectImageBlock = Extract<ContentBlock, { type: "image" }>;
type NestedImageBlock = Extract<ToolResultContentBlock, { type: "image" }>;
type RequestImageBlock = DirectImageBlock | NestedImageBlock;

const preparedImageCache = new WeakMap<RequestImageBlock, Map<string, RequestImageBlock>>();

export function prepareRequestImages(messages: Message[], route: ProviderModelRoute): Message[] {
  const policy = imageRequestPolicyFor(route, { imageCount: countRequestImages(messages) });
  let changed = false;
  const prepared = messages.map((message) => {
    const content = prepareContent(message.content, policy);
    if (content === message.content) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? prepared : messages;
}

export function prepareRequestImage<T extends RequestImageBlock>(
  block: T,
  route: ProviderModelRoute,
  options: { imageCount?: number } = {},
): T {
  return prepareImageBlock(block, imageRequestPolicyFor(route, options));
}

/** Counts direct and tool_result-nested image blocks in the outbound request. */
export function countRequestImages(messages: readonly Message[]): number {
  let count = 0;
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "image") {
        count++;
        continue;
      }
      if (block.type !== "tool_result" || !Array.isArray(block.content)) continue;
      for (const nested of block.content) {
        if (nested.type === "image") count++;
      }
    }
  }
  return count;
}

function prepareContent(blocks: ContentBlock[], policy: ImageRequestPolicy): ContentBlock[] {
  let changed = false;
  const prepared = blocks.map((block) => {
    if (block.type === "image") {
      const image = prepareImageBlock(block, policy);
      if (image !== block) changed = true;
      return image;
    }
    if (block.type !== "tool_result" || !Array.isArray(block.content)) return block;
    const content = prepareToolResultContent(block.content, policy);
    if (content === block.content) return block;
    changed = true;
    return { ...block, content };
  });
  return changed ? prepared : blocks;
}

function prepareToolResultContent(
  blocks: ToolResultContentBlock[],
  policy: ImageRequestPolicy,
): ToolResultContentBlock[] {
  let changed = false;
  const prepared = blocks.map((block) => {
    if (block.type !== "image") return block;
    const image = prepareImageBlock(block, policy);
    if (image !== block) changed = true;
    return image;
  });
  return changed ? prepared : blocks;
}

function prepareImageBlock<T extends RequestImageBlock>(block: T, policy: ImageRequestPolicy): T {
  const policyKey = `${policy.maxEdge}:${policy.maxRawBytes}:${policy.maxPixels}`;
  const cached = preparedImageCache.get(block)?.get(policyKey);
  if (cached) return cached as T;

  const originalBuffer = Buffer.from(block.source.data, "base64");
  if (originalBuffer.length === 0) throw new Error("image data is empty");
  const originalDimensions = readImageDimensions(originalBuffer, block.source.media_type);
  const exceedsDimensions =
    originalDimensions !== null &&
    (originalDimensions.width > policy.maxEdge ||
      originalDimensions.height > policy.maxEdge ||
      originalDimensions.width * originalDimensions.height > policy.maxPixels);
  const exceedsBytes = originalBuffer.length > policy.maxRawBytes;
  if (!exceedsDimensions && !exceedsBytes) {
    cachePreparedImage(block, policyKey, block);
    return block;
  }

  const resized = exceedsDimensions
    ? resizeImageIfTooLarge(originalBuffer, block.source.media_type, {
        maxWidth: policy.maxEdge,
        maxHeight: policy.maxEdge,
        maxPixels: policy.maxPixels,
        targetRawSize: Number.POSITIVE_INFINITY,
      })
    : { buffer: originalBuffer, mediaType: block.source.media_type };
  const compressed =
    resized.buffer.length > policy.maxRawBytes
      ? compressImageToBudget(resized.buffer, resized.mediaType, policy.maxRawBytes)
      : resized;
  const finalDimensions = readImageDimensions(compressed.buffer, compressed.mediaType);
  assertImageWithinPolicy(compressed.buffer, finalDimensions, policy);

  const dimensions = requestImageDimensions(block.dimensions, originalDimensions, finalDimensions);
  const prepared = {
    ...block,
    source: {
      type: "base64" as const,
      media_type: compressed.mediaType,
      data: compressed.buffer.toString("base64"),
    },
    ...(dimensions ? { dimensions } : {}),
  } as T;
  cachePreparedImage(block, policyKey, prepared);
  return prepared;
}

function cachePreparedImage(
  original: RequestImageBlock,
  policyKey: string,
  prepared: RequestImageBlock,
): void {
  const byPolicy = preparedImageCache.get(original) ?? new Map<string, RequestImageBlock>();
  byPolicy.set(policyKey, prepared);
  preparedImageCache.set(original, byPolicy);
}

function requestImageDimensions(
  carried: ImageDimensions | undefined,
  original: { width: number; height: number } | null,
  prepared: { width: number; height: number } | null,
): ImageDimensions | undefined {
  if (!prepared) return carried;
  return {
    originalWidth: carried?.originalWidth ?? original?.width ?? prepared.width,
    originalHeight: carried?.originalHeight ?? original?.height ?? prepared.height,
    displayWidth: prepared.width,
    displayHeight: prepared.height,
  };
}

function assertImageWithinPolicy(
  buffer: Buffer,
  dimensions: { width: number; height: number } | null,
  policy: ImageRequestPolicy,
): void {
  if (buffer.length > policy.maxRawBytes) {
    throw new ImageCompressError(buffer.length, policy.maxRawBytes);
  }
  if (
    dimensions !== null &&
    (dimensions.width > policy.maxEdge ||
      dimensions.height > policy.maxEdge ||
      dimensions.width * dimensions.height > policy.maxPixels)
  ) {
    throw new Error(
      `Unable to resize image (${dimensions.width}x${dimensions.height}) to fit the active route policy. Please use a smaller image.`,
    );
  }
}
