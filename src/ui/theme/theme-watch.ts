import {
  OSC,
  oscColor,
  subscribeTerminalThemeNotify,
  type TerminalProbe,
  wrapForSessionManager,
} from "@/ink";
import { sleep } from "@/kernel/std/sleep.ts";
import { parseOscColor, type SystemTheme, setCachedSystemTheme } from "@/ui/theme/system-theme.ts";
import { isSessionModeActive } from "@/utils/fullscreen.ts";

const DEFAULT_MUX_TIMEOUT_MS = 2000;

let initialProbeAnswered: boolean | undefined;

export function _resetInitialProbeForTesting(): void {
  initialProbeAnswered = undefined;
}

export interface WatchSystemThemeOptions {
  muxTimeoutMs?: number;
}

export function watchSystemTheme(
  querier: TerminalProbe,
  onChange: (theme: SystemTheme) => void,
  options?: WatchSystemThemeOptions,
): () => void {
  let lastTheme: SystemTheme | undefined;
  let cancelled = false;
  let probing = false;
  const muxTimeoutMs = options?.muxTimeoutMs ?? DEFAULT_MUX_TIMEOUT_MS;
  const useDcsPassthrough = Boolean(process.env.TMUX || process.env.STY) && !isSessionModeActive();

  async function probe(): Promise<void> {
    if (probing) return;
    probing = true;
    try {
      const baseQuery = oscColor(OSC.SET_BG_COLOR);
      const wrappedQuery = useDcsPassthrough
        ? { ...baseQuery, request: wrapForSessionManager(baseQuery.request) }
        : baseQuery;

      let response: { data: string } | undefined;

      if (useDcsPassthrough) {
        response = await Promise.race([
          querier.send(wrappedQuery),
          sleep(muxTimeoutMs).then(() => undefined),
        ]);
        if (!response && !cancelled) {
          querier.flush();
          [response] = await Promise.all([querier.send(baseQuery), querier.flush()]);
        }
      } else {
        [response] = await Promise.all([querier.send(wrappedQuery), querier.flush()]);
      }

      if (cancelled) return;
      if (!response) {
        initialProbeAnswered = false;
        return;
      }
      initialProbeAnswered = true;

      const detected = parseOscColor(response.data);
      if (detected === undefined || detected === lastTheme) return;
      lastTheme = detected;
      setCachedSystemTheme(detected);
      onChange(detected);
    } finally {
      probing = false;
    }
  }

  if (initialProbeAnswered !== false) void probe();

  const unsubscribe = subscribeTerminalThemeNotify(() => void probe());

  return () => {
    cancelled = true;
    unsubscribe();
  };
}
