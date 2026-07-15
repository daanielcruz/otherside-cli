import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRepeatingClock } from "@/ink";
import { createAutoClearDispatch } from "@/kernel/std/state/auto-clear-dispatch.ts";
import { hasImageInClipboardAsync } from "@/ui/input/paste/clipboard.ts";

const HINT_TIMEOUT_MS = 8_000;
const HINT_COOLDOWN_MS = 30_000;
const POLL_MS = 5_000;

export function useClipboardImageHint(): boolean {
  const [hint, setHint] = useState(false);
  const hideDispatch = useMemo(() => createAutoClearDispatch({ holdMs: HINT_TIMEOUT_MS }), []);
  const lastShownRef = useRef(0);

  const tick = useCallback((): void => {
    void hasImageInClipboardAsync().then((has) => {
      if (!has) return;
      const now = Date.now();
      if (now - lastShownRef.current < HINT_COOLDOWN_MS) return;
      lastShownRef.current = now;
      setHint(true);
      hideDispatch.arm({ onTimeout: () => setHint(false) });
    });
  }, [hideDispatch]);

  useEffect(() => {
    tick();
    return () => hideDispatch.clear();
  }, [tick, hideDispatch]);

  useRepeatingClock(tick, POLL_MS);

  return hint;
}
