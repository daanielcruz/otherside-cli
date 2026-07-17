import {
  PDF_UNAVAILABLE_PLACEHOLDER,
  type ToolResultContentBlock,
} from "@/kernel/std/types/message.ts";

type WireToolResultContent = string | Array<{ type: string; [k: string]: unknown }>;

export function sanitizeToolResultContent(
  content: string | ToolResultContentBlock[],
): WireToolResultContent {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "image") {
      return {
        type: "image",
        source: {
          type: part.source.type,
          media_type: part.source.media_type,
          data: part.source.data,
        },
      };
    }
    if (part.type === "pdf") {
      return { type: "text", text: PDF_UNAVAILABLE_PLACEHOLDER };
    }
    return part;
  });
}

const EMPTY_ERROR_PLACEHOLDER = "Error (no output)";

function isBlankTextPart(part: { type: string; [k: string]: unknown }): boolean {
  if (part.type !== "text") return false;
  const text = part.text;
  return typeof text !== "string" || text.trim().length === 0;
}

function isEmptyWireContent(content: WireToolResultContent): boolean {
  if (typeof content === "string") return content.trim().length === 0;
  if (content.length === 0) return true;
  return content.every(isBlankTextPart);
}

export function ensureNonEmptyErrorContent(content: WireToolResultContent): WireToolResultContent {
  return isEmptyWireContent(content) ? EMPTY_ERROR_PLACEHOLDER : content;
}
