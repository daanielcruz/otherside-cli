import { formatFileSize } from "@/kernel/mcp/client/output/describe.ts";
import type { ContextRoom } from "@/kernel/std/types/request.ts";

/** A whole-file read past this size needs offset and limit, or allow_large. */
export const MAX_FILE_SIZE = 256 * 1024;
/** A read returning more than this many tokens needs a narrower range, or allow_large. */
export const MAX_OUTPUT_TOKENS = 25000;

// A lifted read may take this share of the room left before compaction; the
// rest is kept for the turn's own reasoning and later tool results.
const ROOM_SHARE = 0.7;
// Bytes a lifted read may cover per token of room: generous, since the token
// count, not the byte count, decides whether the content fits.
const LIFTED_BYTES_PER_TOKEN_SLACK = 3;

export interface ReadLimits {
  maxSizeBytes: number;
  maxTokens: number;
}

export const STANDARD_READ_LIMITS: ReadLimits = {
  maxSizeBytes: MAX_FILE_SIZE,
  maxTokens: MAX_OUTPUT_TOKENS,
};

/**
 * What allow_large can offer this read: the room left in the context, and the
 * raised limits when that room is larger than the standard ones.
 */
export interface LiftedRoom {
  roomTokens: number;
  raised: ReadLimits | undefined;
}

export function liftedRoom(room: ContextRoom, bytesPerToken: number): LiftedRoom {
  const roomTokens = Math.max(0, Math.floor((room.threshold - room.used()) * ROOM_SHARE));
  if (roomTokens <= MAX_OUTPUT_TOKENS) return { roomTokens, raised: undefined };
  return {
    roomTokens,
    raised: {
      maxTokens: roomTokens,
      maxSizeBytes: Math.max(
        MAX_FILE_SIZE,
        roomTokens * bytesPerToken * LIFTED_BYTES_PER_TOKEN_SLACK,
      ),
    },
  };
}

const ANYWAY_HINT =
  " To read it anyway, up to what still fits in your context, call Read again with allow_large: true — only if you genuinely need all of it or the user asked for the whole file.";
const NO_ROOM_HINT =
  " Even with allow_large, this is more than fits in the context you have left this turn (other large reads in the same turn share that room).";

/**
 * The sentence an oversize error ends with: whether calling again with
 * allow_large would fit, or that even it would not.
 */
export function allowLargeHint(
  room: LiftedRoom | undefined,
  optedIn: boolean,
  size: { bytes?: number; tokens?: number },
): string {
  if (room === undefined) return "";
  if (optedIn || room.raised === undefined) return NO_ROOM_HINT;
  const fitsBytes = size.bytes === undefined || size.bytes <= room.raised.maxSizeBytes;
  const fitsTokens = size.tokens === undefined || size.tokens <= room.raised.maxTokens;
  return fitsBytes && fitsTokens ? ANYWAY_HINT : NO_ROOM_HINT;
}

export function fileTooLargeMessage(sizeBytes: number, maxBytes: number, hint: string): string {
  return `File content (${formatFileSize(sizeBytes)}) exceeds maximum allowed size (${formatFileSize(maxBytes)}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.${hint}`;
}

export function tooManyTokensMessage(tokens: number, maxTokens: number, hint: string): string {
  return `File content (${tokens} tokens) exceeds maximum allowed tokens (${maxTokens}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.${hint}`;
}
