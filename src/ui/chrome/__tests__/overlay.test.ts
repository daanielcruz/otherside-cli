import { describe, expect, test } from "bun:test";
import {
  displacingOverlayClosed,
  overlayBlocksPrompt,
  overlayChromeClass,
  overlayDisplacesTranscript,
  overlayIsFullscreen,
  panelChromeState,
} from "../overlay.ts";

describe("overlay chrome behavior", () => {
  test("keeps prompt visible while slash panels own input", () => {
    const state = panelChromeState({
      overlay: "plugins",
      lowerPanelActive: false,
      bgTasksOpen: false,
      pendingInteractive: false,
      quotaPanelActive: false,
      errorPanelActive: false,
      transcriptEmpty: false,
    });

    expect(state.shell.overlayActive).toBe(false);
    expect(state.promptLocked).toBe(true);
    expect(state.shell.displacesTranscript).toBe(false);
  });

  test("keeps prompt visible for compact and displacing panels", () => {
    expect(overlayBlocksPrompt("plugins")).toBe(false);
    expect(overlayBlocksPrompt("model")).toBe(false);
    expect(overlayChromeClass("plugins")).toBe("compact");
    expect(overlayChromeClass("config")).toBe("compact");
    expect(overlayChromeClass("usage")).toBe("compact");
    expect(overlayChromeClass("model")).toBe("displacing");
  });

  test("keeps the workflows list compact", () => {
    expect(overlayBlocksPrompt("workflows")).toBe(false);
    expect(overlayDisplacesTranscript("workflows")).toBe(false);
    expect(overlayIsFullscreen("workflows")).toBe(false);
    expect(overlayChromeClass("workflows")).toBe("compact");
  });

  test("makes only workflow details fullscreen", () => {
    const state = panelChromeState({
      overlay: "workflows",
      workflowDetailOpen: true,
      lowerPanelActive: false,
      bgTasksOpen: false,
      pendingInteractive: false,
      quotaPanelActive: false,
      errorPanelActive: false,
      transcriptEmpty: false,
    });

    expect(state.shell.overlayActive).toBe(true);
    expect(state.shell.displacesTranscript).toBe(true);
    expect(state.promptLocked).toBe(true);
  });

  test("tracks transcript-displacing overlays separately", () => {
    expect(overlayDisplacesTranscript("model")).toBe(true);
    expect(displacingOverlayClosed(null, "model")).toBe(true);
    expect(displacingOverlayClosed("model", "config")).toBe(false);
    expect(displacingOverlayClosed("login", "model")).toBe(true);
    expect(displacingOverlayClosed("login", null)).toBe(false);
    expect(displacingOverlayClosed(null, "login")).toBe(false);
  });

  test("keeps prompt unlocked when no lower panel owns input", () => {
    const state = panelChromeState({
      overlay: null,
      lowerPanelActive: false,
      bgTasksOpen: false,
      pendingInteractive: false,
      quotaPanelActive: false,
      errorPanelActive: false,
      transcriptEmpty: true,
    });

    expect(state.shell.overlayActive).toBe(false);
    expect(state.promptLocked).toBe(false);
    expect(overlayDisplacesTranscript(null)).toBe(false);
  });
});
