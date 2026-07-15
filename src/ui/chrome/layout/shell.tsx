import type { ReactNode } from "react";
import { Box, useTerminalDimensions } from "@/ink";
import { useAppSelect } from "@/store/index.ts";

export interface ShellLayoutProps {
  welcome: ReactNode;
  log: ReactNode;
  progress: ReactNode;
  queue: ReactNode;
  prompt: ReactNode;
  panel: ReactNode;
  footer: ReactNode;
  displacesTranscript?: boolean;
  itemCount?: number;
}

export interface ShellChromeInput {
  overlayActive: boolean;
  lowerPanelActive: boolean;
  overlayKeepsWelcome?: boolean;
  transcriptEmpty?: boolean;
  displacesTranscript?: boolean;
}

export function shellChromeState(input: ShellChromeInput): {
  showFooter: boolean;
  showPrompt: boolean;
  showWelcome: boolean;
  displacesTranscript: boolean;
} {
  const transcriptEmpty = input.transcriptEmpty ?? true;
  const displacesTranscript = input.displacesTranscript ?? false;
  return {
    showFooter: !input.overlayActive && !input.lowerPanelActive,
    showPrompt: !input.overlayActive,
    showWelcome: transcriptEmpty && (!input.overlayActive || input.overlayKeepsWelcome === true),
    displacesTranscript,
  };
}

export function ShellLayout({
  welcome,
  log,
  progress,
  queue,
  prompt,
  panel,
  footer,
  displacesTranscript = false,
  itemCount,
}: ShellLayoutProps): React.JSX.Element {
  const { rows } = useTerminalDimensions();
  const logEpoch = useAppSelect((s) => s.view.logEpoch);
  return (
    <Box flexDirection="column" width="100%">
      {welcome}
      {log}
      <Box
        key={logEpoch}
        flexDirection="column"
        flexShrink={0}
        width="100%"
        {...(displacesTranscript ? { maxHeight: Math.max(1, rows) } : {})}
      >
        {progress}
        {queue}
        {panel}
        {prompt}
        {footer}
      </Box>
    </Box>
  );
}
