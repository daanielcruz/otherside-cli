import type { OverlayName } from "@/store/overlay-stack/index.ts";
import type { ShellChromeInput } from "@/ui/chrome/layout/shell.tsx";

export type OverlayChromeClass = "compact" | "displacing" | "fullscreen";

const OVERLAY_CHROME_CLASS: Partial<Record<OverlayName, OverlayChromeClass>> = {
  resume: "displacing",
  rewind: "displacing",
  help: "displacing",
  model: "displacing",
  mcp: "displacing",
};

export interface PanelChromeStateInput {
  overlay: OverlayName | null;
  lowerPanelActive: boolean;
  bgTasksOpen: boolean;
  pendingInteractive: boolean;
  quotaPanelActive: boolean;
  errorPanelActive: boolean;
  transcriptEmpty: boolean;
  workflowDetailOpen?: boolean;
}

export interface PanelChromeState {
  shell: ShellChromeInput;
  promptLocked: boolean;
}

export function panelChromeState(input: PanelChromeStateInput): PanelChromeState {
  const workflowDetailOpen = input.overlay === "workflows" && input.workflowDetailOpen === true;
  return {
    shell: {
      overlayActive: workflowDetailOpen || overlayBlocksPrompt(input.overlay),
      lowerPanelActive: input.lowerPanelActive,
      overlayKeepsWelcome: input.overlay === "login" || input.overlay === "theme",
      transcriptEmpty: input.transcriptEmpty,
      displacesTranscript: workflowDetailOpen || overlayDisplacesTranscript(input.overlay),
    },
    promptLocked: lowerPanelHasInput(input),
  };
}

export function displacingOverlayClosed(
  overlay: OverlayName | null,
  previousOverlay: OverlayName | null,
): boolean {
  // Covers panel-to-panel swaps (e.g. /model → login): the transcript returns
  // to the viewport whenever the top overlay stops displacing it, not only
  // when the stack empties.
  return !overlayDisplacesTranscript(overlay) && overlayDisplacesTranscript(previousOverlay);
}

export function overlayChromeClass(overlay: OverlayName | null): OverlayChromeClass {
  if (overlay === null) return "compact";
  return OVERLAY_CHROME_CLASS[overlay] ?? "compact";
}

export function overlayBlocksPrompt(overlay: OverlayName | null): boolean {
  return overlayChromeClass(overlay) === "fullscreen";
}

export function overlayDisplacesTranscript(overlay: OverlayName | null): boolean {
  const chromeClass = overlayChromeClass(overlay);
  return chromeClass === "displacing" || chromeClass === "fullscreen";
}

export function overlayIsFullscreen(overlay: OverlayName | null): boolean {
  return overlayChromeClass(overlay) === "fullscreen";
}

function lowerPanelHasInput(input: PanelChromeStateInput): boolean {
  return (
    input.overlay !== null ||
    input.bgTasksOpen ||
    input.pendingInteractive ||
    input.quotaPanelActive ||
    input.errorPanelActive
  );
}
