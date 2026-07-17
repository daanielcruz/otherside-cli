import { useEffect, useRef } from "react";
import { submitClipboardImageHint } from "@/store/app-store/right-region-notices.ts";
import { useIsTerminalFocused } from "@/terminal-runtime";
import { hasImageInClipboardAsync } from "@/ui/input/paste/clipboard.ts";

/** Match reference: probe ~1s after terminal focus gain (not a 5s poll). */
const FOCUS_PROBE_DELAY_MS = 1_000;

const CLIPBOARD_IMAGE_TEXT = "Image in clipboard · ctrl+v to paste";

/**
 * Focus-gain clipboard image probe. Side-effect only: submits an ephemeral
 * right-region notice when an image is detected. Returns nothing — display is
 * owned by RightStatusRegion.
 *
 * @param enabled When false (model cannot accept images), never probe/submit.
 */
export function useClipboardImageHint(enabled = true): void {
  const focused = useIsTerminalFocused();
  const wasFocusedRef = useRef(focused);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const gainedFocus = focused && !wasFocusedRef.current;
    wasFocusedRef.current = focused;
    if (!enabled || !gainedFocus) return;

    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void hasImageInClipboardAsync().then((has) => {
        if (!has) return;
        submitClipboardImageHint(CLIPBOARD_IMAGE_TEXT);
      });
    }, FOCUS_PROBE_DELAY_MS);

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [focused, enabled]);
}
