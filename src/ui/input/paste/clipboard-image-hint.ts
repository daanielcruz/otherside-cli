import { submitClipboardImageHint } from "@/store/app-store/right-region-notices.ts";
import { hasImageInClipboardAsync } from "@/ui/input/paste/clipboard.ts";

// Check once after attention returns; this is not a clipboard poll.
const ATTENTION_PROBE_DELAY_MS = 1_000;
const CLIPBOARD_IMAGE_TEXT = "Image in clipboard · ctrl+v to paste";

/**
 * Checks for a clipboard image after the window regains attention. The route predicate
 * is read when attention changes so a mid-session model switch is respected.
 */
export function createClipboardAttentionProbe(
  routeAcceptsImages: () => boolean,
): (active: boolean) => void {
  let attentionWasActive = false;
  let pendingCheck: ReturnType<typeof setTimeout> | null = null;
  return (active: boolean): void => {
    const attentionArrived = active && !attentionWasActive;
    attentionWasActive = active;
    if (pendingCheck !== null) {
      clearTimeout(pendingCheck);
      pendingCheck = null;
    }
    if (!attentionArrived || !routeAcceptsImages()) return;
    pendingCheck = setTimeout(() => {
      pendingCheck = null;
      void hasImageInClipboardAsync().then((hasImage) => {
        if (hasImage) submitClipboardImageHint(CLIPBOARD_IMAGE_TEXT);
      });
    }, ATTENTION_PROBE_DELAY_MS);
  };
}
