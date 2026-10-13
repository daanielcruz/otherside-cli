import { modelKeepsThinkingOn } from "@/engine/model/facts/model-family.ts";

/** Output tokens a capped request adds for the thinking a model that keeps it on still does. */
export const KEPT_THINKING_HEADROOM_TOKENS = 2048;

/**
 * Asks a Messages body for no thinking and answers whether that took. A model
 * that keeps thinking on cannot be asked, so its body leaves thinking to the
 * server instead.
 */
export function requestNoThinking(body: Record<string, unknown>): boolean {
  if (typeof body.model === "string" && modelKeepsThinkingOn(body.model)) {
    delete body.thinking;
    return false;
  }
  body.thinking = { type: "disabled" };
  return true;
}
