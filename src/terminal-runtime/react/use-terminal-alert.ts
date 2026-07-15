import { createContext, useCallback, useContext, useMemo } from "react";
import { BEL } from "@/terminal-runtime/terminal/ansi-control.js";
import {
  ITERM2_COMMANDS,
  OSC,
  osc,
  PROGRESS_STATES,
  wrapForSessionManager,
} from "@/terminal-runtime/terminal/operating-system-command.js";
import {
  canReportRenderMetrics,
  type RenderPhaseMetrics,
} from "@/terminal-runtime/terminal/runtime-channel.js";

type WriteRaw = (data: string) => void;

export const TerminalOutputContext = createContext<WriteRaw | null>(null);

export const TerminalOutputProvider = TerminalOutputContext.Provider;

export type TerminalAlert = {
  sendITerm2Alert: (opts: { message: string; title?: string }) => void;
  sendKittyAlert: (opts: { message: string; title: string; id: number }) => void;
  sendGhosttyAlert: (opts: { message: string; title: string }) => void;
  sendBellAlert: () => void;

  progress: (state: RenderPhaseMetrics["state"] | null, percentage?: number) => void;
};

export function useTerminalNotification(): TerminalAlert {
  const writeRaw = useContext(TerminalOutputContext);
  if (!writeRaw) {
    throw new Error("useTerminalNotification must be used within TerminalWriteProvider");
  }

  const sendITerm2Alert = useCallback(
    ({ message, title }: { message: string; title?: string }) => {
      const displayString = title ? `${title}:\n${message}` : message;
      writeRaw(wrapForSessionManager(osc(OSC.ITERM2_COMMANDS, `\n\n${displayString}`)));
    },
    [writeRaw],
  );

  const sendKittyAlert = useCallback(
    ({ message, title, id }: { message: string; title: string; id: number }) => {
      writeRaw(wrapForSessionManager(osc(OSC.KITTY, `i=${id}:d=0:p=title`, title)));
      writeRaw(wrapForSessionManager(osc(OSC.KITTY, `i=${id}:p=body`, message)));
      writeRaw(wrapForSessionManager(osc(OSC.KITTY, `i=${id}:d=1:a=focus`, "")));
    },
    [writeRaw],
  );

  const sendGhosttyAlert = useCallback(
    ({ message, title }: { message: string; title: string }) => {
      writeRaw(wrapForSessionManager(osc(OSC.GHOSTTY, "notify", title, message)));
    },
    [writeRaw],
  );

  const sendBellAlert = useCallback(() => {
    writeRaw(BEL);
  }, [writeRaw]);

  const progress = useCallback(
    (state: RenderPhaseMetrics["state"] | null, percentage?: number) => {
      if (!canReportRenderMetrics()) {
        return;
      }
      if (!state) {
        writeRaw(
          wrapForSessionManager(
            osc(OSC.ITERM2_COMMANDS, ITERM2_COMMANDS.PROGRESS_STATES, PROGRESS_STATES.CLEAR, ""),
          ),
        );
        return;
      }
      const pct = Math.max(0, Math.min(100, Math.round(percentage ?? 0)));
      switch (state) {
        case "completed":
          writeRaw(
            wrapForSessionManager(
              osc(OSC.ITERM2_COMMANDS, ITERM2_COMMANDS.PROGRESS_STATES, PROGRESS_STATES.CLEAR, ""),
            ),
          );
          break;
        case "error":
          writeRaw(
            wrapForSessionManager(
              osc(OSC.ITERM2_COMMANDS, ITERM2_COMMANDS.PROGRESS_STATES, PROGRESS_STATES.ERROR, pct),
            ),
          );
          break;
        case "indeterminate":
          writeRaw(
            wrapForSessionManager(
              osc(
                OSC.ITERM2_COMMANDS,
                ITERM2_COMMANDS.PROGRESS_STATES,
                PROGRESS_STATES.INDETERMINATE,
                "",
              ),
            ),
          );
          break;
        case "running":
          writeRaw(
            wrapForSessionManager(
              osc(OSC.ITERM2_COMMANDS, ITERM2_COMMANDS.PROGRESS_STATES, PROGRESS_STATES.SET, pct),
            ),
          );
          break;
        case null:
          break;
      }
    },
    [writeRaw],
  );

  return useMemo(
    () => ({ sendITerm2Alert, sendKittyAlert, sendGhosttyAlert, sendBellAlert, progress }),
    [sendITerm2Alert, sendKittyAlert, sendGhosttyAlert, sendBellAlert, progress],
  );
}
