import type { ImageMediaType } from "@/kernel/std/types/image.ts";

export interface ParsedImageDataUri {
  mediaType: ImageMediaType;
  data: string;
}

const DATA_URI_RE = /^data:(image\/[a-z0-9.+_-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i;
const SUPPORTED_MEDIA_TYPES: Record<string, ImageMediaType> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
};

export function isImageDataUri(text: string): boolean {
  return /^\s*data:image\/[a-z0-9.+_-]+;base64,/i.test(text);
}

export function parseImageDataUri(text: string): ParsedImageDataUri | null {
  const trimmed = text.trim();
  const match = trimmed.match(DATA_URI_RE);
  if (!match?.[1] || !match[2]) return null;
  const mediaType = SUPPORTED_MEDIA_TYPES[match[1].toLowerCase()];
  if (mediaType === undefined) return null;
  const data = match[2].replace(/[\r\n]/g, "");
  if (data.length === 0) return null;
  return { mediaType, data };
}
