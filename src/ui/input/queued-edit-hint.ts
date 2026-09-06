import { loadConfigSync, updateConfig } from "@/kernel/config/config.ts";

/**
 * The one-line teaching hint for editing queued messages. It earns its slot a
 * limited number of times per install; the counter persists in config so the
 * hint retires across sessions once the mechanism has been seen.
 */

export const QUEUED_EDIT_HINT = "Press up to edit queued messages";
const QUEUED_EDIT_HINT_MAX_SHOWS = 3;

export interface QueuedEditHint {
  allowed: boolean;
  markShown: () => void;
}

export function createQueuedEditHint(): QueuedEditHint {
  const allowed =
    (loadConfigSync().global?.queuedEditHintShowCount ?? 0) < QUEUED_EDIT_HINT_MAX_SHOWS;
  let counted = false;
  return {
    allowed,
    markShown: () => {
      if (counted) return;
      counted = true;
      void updateConfig((config) => {
        config.global = {
          ...config.global,
          queuedEditHintShowCount: (config.global?.queuedEditHintShowCount ?? 0) + 1,
        };
      }).catch(() => {});
    },
  };
}
