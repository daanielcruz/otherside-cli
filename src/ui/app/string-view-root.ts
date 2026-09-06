import { subscribe as subscribeBackgroundTasks } from "@/engine/background/tasks/background.ts";
import { subscribeWorkflowTasks } from "@/engine/background/workflows/runtime/store/store.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import { isProviderId, type ProviderId } from "@/kernel/std/types/provider-ids.ts";
import { appStore, dispatch } from "@/store/app-store/index.ts";
import { overlayStack, overlayStore } from "@/store/overlay-stack/index.ts";
import { clearStopConfirm, stopConfirmStore } from "@/store/stop-confirm/index.ts";
import { transcriptActions } from "@/store/transcript/index.ts";
import { runningRef } from "@/store/turn-run/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import {
  type CaretPosition,
  type ScrollbackBatch,
  type StringComponent,
  StringContainer,
  type StringViewContext,
} from "@/terminal-runtime/string-view/component.js";
import { Spacer } from "@/terminal-runtime/string-view/spacer.js";
import {
  activateBackgroundSelection,
  navigateBackgroundRows,
  panelRowKeysForView,
  realignPanelFocus,
  setPanelRowKeys,
  stopAllRunningAgents,
  stopOrCloseBackgroundSelection,
} from "@/ui/app/background-strip-keys.ts";
import type { StringViewDispatch } from "@/ui/app/dispatch/string-view-dispatch.ts";
import { redrawSurface } from "@/ui/app/redraw.ts";
import { StringViewAgentDocument } from "@/ui/app/string-view-agent-document.ts";
import { StringViewAskPrompt } from "@/ui/ask/string-view.ts";
import { typedText } from "@/ui/chrome/key-input.ts";
import {
  restoreTaskListExpansion,
  setTaskListExpanded,
} from "@/ui/chrome/progress/task-list-expansion.ts";
import {
  cycleStringViewPermissionMode,
  seedStringViewBrokerState,
} from "@/ui/chrome/status/string-view-state.ts";
import { StringViewChromeRegion } from "@/ui/chrome/string-view-chrome-region.ts";
import { StringViewProgress } from "@/ui/chrome/string-view-progress.ts";
import { StringViewQueue } from "@/ui/chrome/string-view-queue.ts";
import { StringViewRunningAgents } from "@/ui/chrome/string-view-running-agents.ts";
import {
  armCtrlXChord,
  continuesCtrlXChord,
  ctrlXChordArmed,
  isCtrlXPrefix,
  releaseCtrlXChord,
  takeCtrlXChord,
} from "@/ui/input/ctrl-x-chord.ts";
import { StringViewAutocomplete } from "@/ui/input/string-view-autocomplete.ts";
import { StringViewMentionPicker } from "@/ui/input/string-view-mention-picker.ts";
import { StringViewPrompt } from "@/ui/input/string-view-prompt.js";
import { voiceCaptureActiveRef } from "@/ui/input/voice-hold.ts";
import { lookupKey } from "@/ui/keys/resolver.ts";
import { StringViewPermissionPrompt } from "@/ui/panels/permission/string-view.ts";
import { StringViewOverlayHost } from "@/ui/panels/string-view-overlay-host.ts";
import { isPortedOverlay } from "@/ui/panels/string-view-registry.ts";
import { StringViewDetailedTranscript } from "@/ui/transcript/string-view-detailed-transcript.ts";
import { StringViewTranscript } from "@/ui/transcript/string-view-transcript.js";
import { transcriptInputAction } from "@/ui/transcript/string-view-transcript-input.ts";

/**
 * Root string-view tree booted under `OTHERSIDE_RENDERER=pitui`. The prompt screen
 * carries the settled transcript above the interactive prompt, the ported footer
 * panels, and the chrome footer; a ported panel opens above the prompt (chrome yields)
 * when its slash command is submitted. `StringViewRoot` swaps the prompt screen for the
 * full-screen detailed reader when it is active. The boot fixture enters through the
 * transcript store so the same subscription path handles later updates. Full slash
 * dispatch (model turns, non-overlay commands) lands later.
 */
export function buildStringViewRoot(
  config: Pick<UserConfig, "verbose"> = {},
  turnDispatch?: StringViewDispatch,
  initialTranscript?: readonly TranscriptEntry[],
): StringComponent {
  const promptScreen = new StringContainer();
  // The persisted verbose flag opens the session expanded; the store is the live
  // source so /config applies without a restart.
  dispatch({ type: "view/setVerboseTranscript", verbose: config.verbose === true });
  const transcript = new StringViewTranscript();
  const prompt = new StringViewPrompt(
    (text) => {
      if (openPortedOverlayFromInput(text, turnDispatch)) return;
      turnDispatch?.submit(text);
    },
    () => openRewindFromEmptyPrompt(turnDispatch?.rewindToTranscriptId),
    turnDispatch?.restoreQueued,
  );
  seedStringViewBrokerState();
  restoreTaskListExpansion();
  const demoTranscript: readonly TranscriptEntry[] = [
    { id: "u_pitui_demo", kind: "user", text: "oi" },
    {
      id: "a_pitui_demo",
      kind: "assistant",
      text: "Olá! Posso ajudar com **markdown**, `código inline` e listas:\n\n- primeiro item\n- segundo item\n\n```ts\nconst answer = 42;\n```",
    },
    {
      id: "r_pitui_read_demo",
      kind: "tool",
      title: "Read",
      input: JSON.stringify({ file_path: "/workspace/app.ts" }),
      text: "42 lines read from /workspace/app.ts",
      resultMeta: { kind: "read", numLines: 42, startLine: 1, totalLines: 42 },
    },
    {
      id: "r_pitui_bash_demo",
      kind: "tool",
      title: "Bash",
      input: JSON.stringify({ command: "bun test" }),
      text: JSON.stringify({
        stdout: "12 pass\n0 fail\nRan 12 tests across 1 file",
        stderr: "",
        exit_code: 0,
      }),
    },
    {
      id: "thinking_pitui_demo",
      kind: "thinking",
      text: "Checking the **string-view** transcript mapping.",
    },
    {
      id: "system_pitui_demo",
      kind: "system",
      text: "System transcript notice",
    },
    {
      id: "slash_error_pitui_demo",
      kind: "slash_error",
      text: "Example slash-command error",
    },
    {
      id: "skill_pitui_demo",
      kind: "skill",
      text: "Successfully loaded skill",
    },
    {
      id: "compaction_pitui_demo",
      kind: "compaction",
      text: "Compacted conversation",
      filesRead: [{ path: "/workspace/OTHERSIDE.md", numLines: 18 }],
    },
    {
      id: "compact_done_pitui_demo",
      kind: "compact_done",
      text: "Compaction complete",
    },
  ];
  transcriptActions.replace(
    process.env.OTHERSIDE_PITUI_DEMO === "1" ? demoTranscript : (initialTranscript ?? []),
  );
  promptScreen.addChild(new Spacer(1));
  promptScreen.addChild(new StringViewProgress());
  const overlayHost = new StringViewOverlayHost();
  promptScreen.addChild(overlayHost);
  promptScreen.addChild(new StringViewPermissionPrompt());
  promptScreen.addChild(new StringViewAskPrompt());
  promptScreen.addChild(new StringViewQueue());
  promptScreen.addChild(prompt);
  promptScreen.addChild(new StringViewAutocomplete(prompt));
  promptScreen.addChild(new StringViewMentionPicker(prompt));
  promptScreen.addChild(new StringViewChromeRegion());
  // Running agents close the footer, under the status rows — the queue preview stays
  // above the input because it is about what the prompt will send next.
  promptScreen.addChild(new StringViewRunningAgents());
  return new StringViewRoot(
    promptScreen,
    prompt,
    transcript,
    new StringViewDetailedTranscript(transcript),
    new StringViewAgentDocument(),
    overlayHost,
    turnDispatch?.cancel,
    turnDispatch?.backgroundCurrentTool,
  );
}

type ScrollbackOwner = "main" | "agent" | "none";

/**
 * The frame-claiming half of the overlay host, which is all the root consults:
 * whether the mounted panel wants the whole screen, and what to draw when it does.
 */
interface FullscreenPanelSource {
  isFullscreen(): boolean;
  render(width: number): string[];
}

export class StringViewRoot implements StringComponent {
  private context: StringViewContext | undefined;
  private scrollbackOwner: ScrollbackOwner = "main";
  /** Row the footer started on in the last render; null while it is not on screen. */
  private promptScreenRow: number | null = null;
  /** Rows clipped off the footer's head in the last render. */
  private footerClippedRowCount = 0;
  private panelUnsubs: (() => void)[] = [];

  constructor(
    private readonly promptScreen: StringComponent,
    private readonly prompt: StringViewPrompt,
    private readonly transcript: StringViewTranscript,
    private readonly detailedTranscript: StringViewDetailedTranscript,
    private readonly agentDocument: StringViewAgentDocument,
    private readonly overlayHost: FullscreenPanelSource,
    private readonly cancelTurn?: () => boolean,
    private readonly backgroundCurrentTool?: () => boolean,
  ) {}

  mount(ctx: StringViewContext): void {
    this.context = ctx;
    // The survivor-follow snapshot belongs to this mount: seed it from the
    // current strip so a fresh root can preserve rows that already existed.
    setPanelRowKeys(panelRowKeysForView());
    this.transcript.mount(ctx);
    this.promptScreen.mount?.(ctx);
    this.detailedTranscript.mount(ctx);
    this.agentDocument.mount(ctx);
    // Panel rows leave on their own schedule — a run finishing, an eviction, an
    // armed confirmation expiring — not only under a key press. Focus follows
    // the rows reactively so the reader is never parked on an empty strip.
    this.panelUnsubs = [
      subscribeBackgroundTasks(realignPanelFocus),
      subscribeWorkflowTasks(realignPanelFocus),
      stopConfirmStore.subscribe(realignPanelFocus),
    ];
  }

  unmount(): void {
    for (const unsub of this.panelUnsubs) unsub();
    this.panelUnsubs = [];
    this.agentDocument.unmount();
    this.detailedTranscript.unmount();
    this.promptScreen.unmount?.();
    this.transcript.unmount();
    this.context = undefined;
  }

  render(width: number): string[] {
    if (this.detailedTranscript.isActive()) {
      this.promptScreenRow = null;
      return this.detailedTranscript.render(width);
    }
    // A panel claiming the whole frame takes the conversation's rows and the
    // prompt's with it; closing hands both back through the ownership switch.
    if (this.overlayHost.isFullscreen()) {
      this.promptScreenRow = null;
      return this.overlayHost.render(width);
    }
    // The agent document replaces the conversation but keeps the footer: it is a
    // conversation surface of its own, not a full-screen reader.
    const footer = this.boundedFooterRows(width);
    const above = this.agentDocument.isActive()
      ? this.boundedRows(this.agentDocument.render(width), footer.length)
      : this.boundedLiveRows(width, footer.length);
    this.promptScreenRow = above.length;
    return [...above, ...footer];
  }

  /**
   * The height ledger's footer half: a footer alone taller than the screen (a
   * permission panel on a very short terminal) scrolls itself into scrollback
   * and ratchets ghost copies like any oversized frame. Clipping the head keeps
   * the tail, where the actionable rows live — options, prompt, status.
   */
  private boundedFooterRows(width: number): string[] {
    const full = this.promptScreen.render(width);
    const viewportRows = this.context?.terminalRows?.() ?? 0;
    if (viewportRows <= 0 || full.length <= viewportRows) {
      this.footerClippedRowCount = 0;
      return full;
    }
    this.footerClippedRowCount = full.length - viewportRows;
    return full.slice(this.footerClippedRowCount);
  }

  /**
   * The live tail is bounded to the viewport. A frame taller than the screen
   * physically scrolls, freezing still-live rows into scrollback where the next
   * paint draws them again as ghost copies. Clipping from the head keeps the
   * newest rows against the prompt; nothing is lost — clipped content re-enters
   * through the settled path once it stops changing, which is the only road
   * into scrollback.
   */
  private boundedLiveRows(width: number, footerRowCount: number): string[] {
    return this.boundedRows(this.transcript.renderLive(width), footerRowCount);
  }

  private boundedRows(live: string[], footerRowCount: number): string[] {
    const viewportRows = this.context?.terminalRows?.() ?? 0;
    if (viewportRows <= 0) return live;
    const budget = Math.max(0, viewportRows - footerRowCount);
    return live.length > budget ? live.slice(live.length - budget) : live;
  }

  /** The prompt sits inside the footer, so its caret carries the rows above it. */
  caret(width: number): CaretPosition | null {
    const start = this.promptScreenRow;
    if (start === null) return null;
    const own = this.promptScreen.caret?.(width);
    if (own === undefined || own === null) return null;
    // A clipped footer head shifts every remaining row up; a caret that sat on
    // a clipped row has no cell to park on.
    const row = own.row - this.footerClippedRowCount;
    if (row < 0) return null;
    return { row: start + row, column: own.column };
  }

  takeScrollbackBatch(width: number): ScrollbackBatch {
    const owner = this.scrollbackOwnerNow();
    if (owner !== this.scrollbackOwner) {
      this.scrollbackOwner = owner;
      // Surface ownership changed, so the host must establish the incoming history.
      return { mode: "switch", rows: [...this.ownedSnapshot(owner, width)] };
    }
    if (owner === "main") return this.transcript.takeScrollbackBatch(width);
    if (owner === "agent") return this.agentDocument.takeScrollbackBatch(width);
    return { mode: "idle" };
  }

  snapshotScrollback(width: number): readonly string[] {
    this.scrollbackOwner = this.scrollbackOwnerNow();
    return this.ownedSnapshot(this.scrollbackOwner, width);
  }

  private ownedSnapshot(owner: ScrollbackOwner, width: number): readonly string[] {
    if (owner === "main") return this.transcript.snapshotScrollback(width);
    if (owner === "agent") return this.agentDocument.snapshotScrollback(width);
    return [];
  }

  /** Which document's settled history scrolls; the full-screen reader owns none. */
  private scrollbackOwnerNow(): ScrollbackOwner {
    if (this.detailedTranscript.isActive() || this.overlayHost.isFullscreen()) return "none";
    return this.agentDocument.isActive() ? "agent" : "main";
  }

  handleKey(key: KeyEventData): boolean {
    // The full-screen reader and any modal surface (permission prompt, overlays)
    // own input through the focus stack. The root must not steal interruption,
    // mode-cycle, or toggle keys from a surface that currently holds focus —
    // otherwise shift+tab could switch to an auto-approve mode, or Esc could
    // cancel the turn, while a permission request is waiting for its answer.
    if (this.detailedTranscript.isActive()) return false;
    if (this.context?.currentFocus?.() !== this.prompt) return false;
    // An active voice capture owns Escape (cancel, keep the buffer): the key
    // must reach the prompt's hold machine before any cancel ladder here.
    if (key.name === "escape" && voiceCaptureActiveRef.current) return false;
    // Stopping the fleet is a chat-wide gesture: the prefix arms wherever the chat
    // owns the keys, not only on the strip. Ctrl+E finishes the same prefix inside
    // the prompt, so only a key that finishes neither lets the prefix go.
    if (isCtrlXPrefix(key)) {
      armCtrlXChord();
      return true;
    }
    if (ctrlXChordArmed() && !continuesCtrlXChord(key)) releaseCtrlXChord();
    if (key.ctrl && key.name === "k" && takeCtrlXChord()) {
      stopAllRunningAgents();
      return true;
    }
    // Escape steps the reader off the rows first; only the next press moves
    // down the ladder (document close, then turn interrupt).
    if (key.name === "escape" && appStore.getState().view.panelFocused) {
      clearStopConfirm();
      dispatch({ type: "view/setPanelFocused", focused: false });
      return true;
    }
    // Escape leaves the agent document before it can reach the turn-interrupt ladder.
    if (key.name === "escape" && this.agentDocument.isActive() && this.prompt.isEmpty()) {
      dispatch({ type: "view/setViewingAgent", id: null });
      // Closing the document folds its subtree; the cursor follows its row.
      realignPanelFocus();
      return true;
    }
    // The prompt holds focus: a running turn claims the interruption keys, then
    // shift+tab cycles the permission mode, then the transcript-screen toggle. A
    // non-empty prompt clears its edit first (the prompt owns that step), so only an
    // empty prompt lets Ctrl+C / Esc cancel the running turn.
    // The key is only consumed when a turn was actually aborted. `runningRef`
    // outlives the guard whenever a turn is still unwinding, so consuming on it
    // alone eats every later press in silence and reads as a dead keyboard.
    const interruptsTurn = (key.ctrl && key.name === "c") || key.name === "escape";
    if (interruptsTurn && runningRef.current && this.prompt.isEmpty()) {
      if (this.cancelTurn?.() === true) return true;
    }
    // The `turn` context is pushed only while a turn runs, and pushed innermost:
    // the same chord moves the caret in the prompt when there is nothing to
    // background, which a context stack says exactly by the context being absent.
    const running = runningRef.current;
    if (running && lookupKey({ key, contexts: ["turn"] }).kind === "action") {
      if (this.backgroundCurrentTool?.()) return true;
    }
    if ((key.name === "up" || key.name === "down") && this.prompt.isEmpty()) {
      if (navigateBackgroundRows(key.name)) return true;
    }
    if (key.name === "return" && activateBackgroundSelection()) {
      clearStopConfirm();
      return true;
    }
    if (appStore.getState().view.panelFocused) {
      // A focused row owns the keys: x stops then closes the selection, and typing
      // never leaks into the prompt while the reader is on the rows — unless a
      // document is open, where the typed text is a message to the viewed agent and
      // the reader releases the rows so the prompt can take it.
      if (key.name === "x" && !key.ctrl && !key.meta && stopOrCloseBackgroundSelection()) {
        return true;
      }
      // Only bare typing is held back. A modified key carries a gesture, not
      // text — Ctrl+E finishing the Ctrl+X prefix has to reach the prompt — and
      // `keyInput` reports a modified key by name, which would read as typed.
      if (typedText(key).length > 0) {
        if (appStore.getState().view.viewingAgentId !== null) {
          clearStopConfirm();
          dispatch({ type: "view/setPanelFocused", focused: false });
          return false;
        }
        return true;
      }
    }
    if (key.shift && key.name === "tab") {
      cycleStringViewPermissionMode();
      return true;
    }
    if (key.ctrl && key.name === "t") {
      setTaskListExpanded(!appStore.getState().view.tasksExpanded);
      return true;
    }
    // Nothing on our side changed, so nothing would repaint on its own: the
    // press is the evidence that what is on screen is not what we think.
    if (key.ctrl && key.name === "l") return redrawSurface();
    if (transcriptInputAction(key, "prompt") !== "toggle-screen") return false;
    dispatch({ type: "view/toggleTranscriptScreen" });
    return true;
  }
}

function openRewindFromEmptyPrompt(
  onRewind: StringViewDispatch["rewindToTranscriptId"] | undefined,
): void {
  if (runningRef.current || overlayStore.getState().openStack.length > 0) return;
  openRewindOverlay(onRewind);
}

function openRewindOverlay(onRewind: StringViewDispatch["rewindToTranscriptId"] | undefined): void {
  if (onRewind === undefined) {
    overlayStack.open("rewind");
    return;
  }
  overlayStack.open("rewind", { onRewind });
}

function openResumeOverlay(onResumeSession: StringViewDispatch["resumeSession"] | undefined): void {
  if (onResumeSession === undefined) {
    overlayStack.open("resume");
    return;
  }
  overlayStack.open("resume", { onResumeSession });
}

export function openPortedOverlayFromInput(
  text: string,
  turnDispatch: StringViewDispatch | undefined,
): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return false;
  const [name = "", ...argParts] = trimmed.slice(1).split(/\s+/);
  if (!isPortedOverlay(name) || name === "error" || name === "quota") return false;
  const args = argParts.join(" ").trim();

  if (name === "config" && (args === "details" || args === "config")) {
    overlayStack.open("config", { initialTab: args });
    return true;
  }
  if (name === "login" && args.length > 0 && isProviderId(args)) {
    openLoginOverlay(turnDispatch, args);
    return true;
  }
  if (args.length > 0) return false;
  if (name === "rewind") {
    openRewindOverlay(turnDispatch?.rewindToTranscriptId);
    return true;
  }
  if (name === "resume") {
    openResumeOverlay(turnDispatch?.resumeSession);
    return true;
  }
  if (name === "login") {
    openLoginOverlay(turnDispatch);
    return true;
  }
  if (name === "design") {
    overlayStack.open(
      "design",
      turnDispatch === undefined
        ? undefined
        : { session: turnDispatch.session, controller: turnDispatch.designController() },
    );
    return true;
  }
  if (name === "logout") {
    overlayStack.open(
      "logout",
      turnDispatch === undefined ? undefined : { broker: turnDispatch.broker },
    );
    return true;
  }
  overlayStack.open(name);
  return true;
}

function openLoginOverlay(
  turnDispatch: StringViewDispatch | undefined,
  initialProvider?: ProviderId,
): void {
  overlayStack.open(
    "login",
    turnDispatch === undefined
      ? undefined
      : {
          broker: turnDispatch.broker,
          config: turnDispatch.config,
          onConfigChange: turnDispatch.onConfigChange,
          ...(initialProvider !== undefined ? { initialProvider } : {}),
        },
  );
}
