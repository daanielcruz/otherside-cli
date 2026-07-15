import { errorMessage } from "@/kernel/std/errno.ts";
import { resizeImageIfTooLarge } from "@/kernel/std/image-resize.ts";
import type { ImageMediaType } from "@/kernel/std/types/image.ts";
import type { ToolResultContentBlock } from "@/kernel/std/types/message.ts";

export function contentContainsImages(content: string | ToolResultContentBlock[]): boolean {
  return Array.isArray(content) && content.some((block) => block.type === "image");
}

export function imageBlock(data: string, mimeTypeValue: unknown): ToolResultContentBlock {
  try {
    const mediaType = imageMediaType(mimeTypeValue);
    const resized = resizeImageIfTooLarge(Buffer.from(data, "base64"), mediaType);
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: resized.mediaType,
        data: resized.buffer.toString("base64"),
      },
      ...(resized.dimensions
        ? {
            dimensions: {
              originalWidth: resized.dimensions.originalWidth,
              originalHeight: resized.dimensions.originalHeight,
              displayWidth: resized.dimensions.width,
              displayHeight: resized.dimensions.height,
            },
          }
        : {}),
    };
  } catch (error) {
    const message = errorMessage(error);
    return textBlock(`[image resize failed: ${message}]`);
  }
}

export function imageMediaType(value: unknown): ImageMediaType {
  if (value === "image/jpeg") return "image/jpeg";
  if (value === "image/gif") return "image/gif";
  if (value === "image/webp") return "image/webp";
  return "image/png";
}

export function isImageMimeType(value: unknown): boolean {
  return (
    value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/gif" ||
    value === "image/webp"
  );
}

export function extensionForMimeType(mimeType: string | undefined): string {
  const base = mimeType?.split(";")[0]?.trim().toLowerCase();
  if (base === "application/pdf") return "pdf";
  if (base === "application/json") return "json";
  if (base === "text/csv") return "csv";
  if (base === "text/plain") return "txt";
  if (base === "text/html") return "html";
  if (base === "text/markdown") return "md";
  if (base === "application/zip") return "zip";
  if (base === "image/png") return "png";
  if (base === "image/jpeg") return "jpg";
  if (base === "image/gif") return "gif";
  if (base === "image/webp") return "webp";
  if (base === "image/svg+xml") return "svg";
  return "bin";
}

export function ensureNonEmptyContent(
  content: string | ToolResultContentBlock[],
  toolName: string,
): string | ToolResultContentBlock[] {
  if (typeof content === "string")
    return content.trim().length > 0 ? content : `(${toolName} completed with no output)`;
  if (content.length === 0) return `(${toolName} completed with no output)`;
  const hasContent = content.some((block) => block.type !== "text" || block.text.trim().length > 0);
  return hasContent ? content : `(${toolName} completed with no output)`;
}

export function textBlock(text: string): ToolResultContentBlock {
  return { type: "text", text };
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

export function stringifyInline(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

export function hasField(value: unknown, key: string): boolean {
  return value !== null && typeof value === "object" && Reflect.has(value, key);
}

export function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
}
