import { useEffect, useRef, useState } from "react";
import { loadConfigSync, updateConfig } from "@/kernel/config/config.ts";

// The "Press up to edit queued messages" hint is a teaching aid: it shows on
// the first three occasions and stays silent once the user has seen it enough.
const QUEUED_EDIT_HINT_MAX_SHOWS = 3;

// Gates the queued-edit prompt hint behind a persisted show counter. The
// allowance is latched at mount so the hint never vanishes mid-session; the
// counter is bumped once per session, on the first appearance.
export function useQueuedEditHint(eligible: boolean): boolean {
  const [allowed] = useState(
    () => (loadConfigSync().global?.queuedEditHintShowCount ?? 0) < QUEUED_EDIT_HINT_MAX_SHOWS,
  );
  const shown = eligible && allowed;
  const counted = useRef(false);
  useEffect(() => {
    if (!shown || counted.current) return;
    counted.current = true;
    try {
      updateConfig((cfg) => {
        cfg.global = {
          ...cfg.global,
          queuedEditHintShowCount: (cfg.global?.queuedEditHintShowCount ?? 0) + 1,
        };
      });
    } catch {
      // A read-only config never blocks the hint itself.
    }
  }, [shown]);
  return shown;
}
