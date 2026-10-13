import { formatBytes } from "@/kernel/std/text/format.ts";

/**
 * Published request-body limits, by provider. A provider that publishes none gets
 * a size report without a limit, since a guessed one would mislead.
 */
const REQUEST_BODY_LIMIT_BYTES: Readonly<Record<string, number>> = {
  anthropic: 32 * 1024 * 1024,
};

export interface RequestBodyAssessment {
  kind: "unrecoverable" | "strippable_media" | "compactable";
  bodyBytes: number;
  mediaBytes: number;
  /** Absent when the provider publishes no limit. */
  limitBytes?: number;
}

const MEDIA_MIME_PATTERN = /^(?:image\/|application\/pdf)/;
const DATA_URL_PATTERN = /^data:(?:image\/|application\/pdf)[^;]*;base64,/;

/** Bytes the body takes on the wire, as serialized for sending. */
export function requestBodyBytes(body: unknown): number {
  try {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return text === undefined ? 0 : Buffer.byteLength(text, "utf8");
  } catch {
    return 0;
  }
}

function isMediaCarrier(record: Record<string, unknown>): boolean {
  const mime = record.media_type ?? record.mimeType ?? record.mime_type;
  return typeof mime === "string" && MEDIA_MIME_PATTERN.test(mime);
}

/**
 * Bytes of inline media in a wire body, whatever its shape: a base64 payload beside
 * its media type (Anthropic `source`, Gemini `inlineData`) or a media data URL
 * (OpenAI-style `image_url`, Codex `input_image`).
 */
function mediaByteLength(value: unknown, seen = new Set<object>()): number {
  if (typeof value === "string") return DATA_URL_PATTERN.test(value) ? value.length : 0;
  if (value === null || typeof value !== "object" || seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value))
    return value.reduce((sum, item) => sum + mediaByteLength(item, seen), 0);
  const record = value as Record<string, unknown>;
  if (typeof record.data === "string" && isMediaCarrier(record)) return record.data.length;
  let total = 0;
  for (const nested of Object.values(record)) total += mediaByteLength(nested, seen);
  return total;
}

/** How big a rejected body was, how much of it was media, and so what can bring it under. */
export function assessRequestBody(body: unknown, provider: string): RequestBodyAssessment {
  const bodyBytes = requestBodyBytes(body);
  const mediaBytes = mediaByteLength(body);
  const limitBytes = REQUEST_BODY_LIMIT_BYTES[provider];
  const kind =
    limitBytes !== undefined && bodyBytes - mediaBytes > limitBytes
      ? "unrecoverable"
      : mediaBytes > 0
        ? "strippable_media"
        : "compactable";
  return { kind, bodyBytes, mediaBytes, ...(limitBytes !== undefined ? { limitBytes } : {}) };
}

function smallerThanOneKb(bytes: number): string {
  return bytes < 1024 ? "less than 1 KB" : formatBytes(bytes);
}

const MEDIA_RECOVERY =
  "Accumulated images and attachments in the conversation pushed the request over the limit. Run /compact, or double press esc to go back and remove attachments.";

/**
 * What the reader can do about a body the provider refused for its size. Compacting
 * replaces every image with a placeholder, so it recovers a body that media made too
 * big; when the text alone is over the limit, only going back or starting over can.
 */
export function requestTooLargeMessage(assessment?: RequestBodyAssessment): string {
  const limit = assessment?.limitBytes;
  if (assessment?.kind === "unrecoverable" && limit !== undefined) {
    const media =
      assessment.mediaBytes === 0
        ? "none of it is images or documents that could be removed"
        : `only ${smallerThanOneKb(assessment.mediaBytes)} of it is images or documents that could be removed`;
    return `Request too large for the API's ${formatBytes(limit)} request limit: this conversation is about ${formatBytes(assessment.bodyBytes)}, and ${media}, so removing attachments or compacting cannot make it fit. Double press esc to go back past the large content, or /clear to start a new conversation.`;
  }
  const max = limit === undefined ? "" : `max ${formatBytes(limit)}`;
  if (assessment?.kind === "strippable_media") {
    const share = `${smallerThanOneKb(assessment.mediaBytes)} of about ${formatBytes(assessment.bodyBytes)} is images or documents`;
    return `Request too large (${max ? `${max}; ` : ""}${share}). ${MEDIA_RECOVERY}`;
  }
  return `Request too large${max ? ` (${max})` : ""}. ${MEDIA_RECOVERY}`;
}
