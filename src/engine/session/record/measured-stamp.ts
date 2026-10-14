import { lt } from "@/kernel/std/semver.ts";
import type { AssistantRequestUsage } from "./schema.ts";

/** The first release that stamps a main-turn request from its final stream reading. */
const FINAL_READING_STAMPS_SINCE = "1.2.0";

/** What a transcript line says about the turn that wrote its usage stamp. */
export interface StampWriter {
  /** The otherside version recorded on the line. */
  version: unknown;
  provider: unknown;
  sidechain: boolean;
}

type PromptCounters = Pick<AssistantRequestUsage, "input_tokens" | "cache_read_input_tokens">;

/**
 * A usage stamp as what its request held.
 *
 * Main-turn Antigravity stamps written before 1.2.0 added every stream frame's
 * prompt reading together: the whole prompt from the frames that arrived before the
 * cache figure, then the cached share from the last frame. Read as written, such a
 * stamp reports close to twice the prompt, so a resumed session looks full. The
 * larger of the two counters is the closest reading of the prompt the stamp still
 * holds, and the fresh share is what the cached share leaves of it.
 *
 * The line does not say whether its stamp was summed, and a few of that era were
 * not; those read short by their fresh share. That errs toward resuming without
 * compacting, which the next live reading corrects, rather than toward compacting
 * a conversation that still fits.
 */
export function measuredStamp<T extends PromptCounters>(stamp: T, writer: StampWriter): T {
  if (!summedFrameReadings(writer)) return stamp;
  const fresh = Math.max(0, stamp.input_tokens - stamp.cache_read_input_tokens);
  return fresh === stamp.input_tokens ? stamp : { ...stamp, input_tokens: fresh };
}

function summedFrameReadings(writer: StampWriter): boolean {
  return (
    !writer.sidechain &&
    writer.provider === "antigravity" &&
    writtenBefore(writer.version, FINAL_READING_STAMPS_SINCE)
  );
}

/** A line whose version cannot be read proves nothing about its writer. */
function writtenBefore(version: unknown, release: string): boolean {
  if (typeof version !== "string") return false;
  try {
    return lt(version, release);
  } catch {
    return false;
  }
}
