import { createAutoClearDispatch } from "@/kernel/std/state/auto-clear-dispatch.ts";
import {
  appleTerminalShiftReader,
  isAppleTerminalShiftReturn,
} from "@/platform/apple-terminal/shift-return.ts";
import { appStore } from "@/store/app-store/index.ts";
import { promptStore, setPromptEditorMode } from "@/store/prompt/index.ts";
import { windowAttentionStore } from "@/store/window-attention/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type {
  CaretPosition,
  StringComponent,
  StringViewContext,
} from "@/terminal-runtime/string-view/component.js";
import { isFooterNoticeDismissKey } from "@/ui/chrome/footer-notice.ts";
import { isInsertable } from "@/ui/chrome/key-input.ts";
import { entersBashMode, exitsBashMode } from "@/ui/input/bash-mode.ts";
import { takeCtrlXChord } from "@/ui/input/ctrl-x-chord.ts";
import { HistorySearchSession } from "@/ui/input/history-search-session.ts";
import { interruptKillChain } from "@/ui/input/kill-ring.ts";
import { editorModeAnnouncement } from "@/ui/input/prompt-chrome.ts";
import { PromptDraft } from "@/ui/input/prompt-draft.ts";
import {
  deleteNextGraphemeEdit,
  deletePrevGraphemeEdit,
  type PromptEdit,
} from "@/ui/input/prompt-edit-ops.ts";
import {
  continuesKillChain,
  effectivePromptKeyName,
  type PromptEditShortcut,
  promptEditShortcut,
} from "@/ui/input/prompt-edit-shortcuts.ts";
import { editPromptExternally } from "@/ui/input/prompt-editor.ts";
import { promptFrame } from "@/ui/input/prompt-frame.ts";
import { PromptKeyword } from "@/ui/input/prompt-keyword.ts";
import { PromptNotices } from "@/ui/input/prompt-notices.ts";
import { openPromptPanel, promptPanelFor } from "@/ui/input/prompt-panel-keys.ts";
import { PromptPaste } from "@/ui/input/prompt-paste.ts";
import { PromptStash } from "@/ui/input/prompt-stash.ts";
import {
  nextGraphemeBoundary,
  nextWordBoundary,
  prevGraphemeBoundary,
  prevWordBoundary,
  visualLineEndOffset,
  visualLineStartOffset,
} from "@/ui/input/prompt-text.js";
import { createQueuedEditHint, type QueuedEditHint } from "@/ui/input/queued-edit-hint.ts";
import { VimSession } from "@/ui/input/vim/session.ts";
import { VoiceHold } from "@/ui/input/voice-hold.ts";

const EMPTY_ESCAPE_HOLD_MS = 600;
const DEFAULT_TERMINAL_ROWS = 24;
const ESCAPE_CLEAR_NOTICE = "Press Esc again to clear";
const STASHED_NOTICE = "prompt stashed · ctrl+s to restore";
const RESTORED_NOTICE = "prompt restored";
/** A kill fills the ring, so the row that follows it says how to spend it. */
const YANK_NOTICE = "Ctrl+Y to paste deleted text";

export class StringViewPrompt implements StringComponent {
  private queuedEditHintShown = false;
  private caretPosition: CaretPosition | null = null;
  private context: StringViewContext | undefined;
  private unsub: (() => void) | undefined;
  private unsubAttention: (() => void) | undefined;
  private unsubView: (() => void) | undefined;
  private readonly emptyEscape = createAutoClearDispatch({ holdMs: EMPTY_ESCAPE_HOLD_MS });
  private readonly notices = new PromptNotices(() => this.context?.requestRender());
  private readonly stash = new PromptStash();
  private readonly keyword = new PromptKeyword(() => this.context?.requestRender());
  private readonly draft = new PromptDraft({
    requestRender: () => this.context?.requestRender(),
    onReplaced: () => this.paste.hideExpandHint(),
  });
  private readonly paste = new PromptPaste({
    text: () => this.draft.getText(),
    caret: () => this.draft.getCaretOffset(),
    terminalRows: () => this.context?.terminalRows?.() ?? DEFAULT_TERMINAL_ROWS,
    leaveHistory: () => this.draft.leaveHistory(),
    apply: (text, caret) => this.draft.setText(text, caret),
  });
  private readonly vim = new VimSession(this.draft);
  private readonly search = new HistorySearchSession({
    entries: (scope) => this.draft.history().searchEntries(scope),
    applyText: (text, caret) => this.draft.setText(text, caret),
    submit: () => this.submit(),
    requestRender: () => this.context?.requestRender(),
  });
  // Space push-to-talk: dictation lands in the buffer through the same
  // setText path as typing, and a double space submits the transcript.
  private readonly voice = new VoiceHold({
    buffer: () => this.draft.getText(),
    cursor: () => this.draft.getCaretOffset(),
    apply: (text, caret) => this.draft.setText(text, caret),
    submit: (text) => this.submitVoiceTranscript(text),
    requestRender: () => this.context?.requestRender(),
  });

  constructor(
    private readonly onSubmit?: (text: string) => void,
    private readonly onEmptyDoubleEscape?: () => void,
    private readonly onRestoreQueued?: () => string | null,
    private readonly queuedEditHint: QueuedEditHint = createQueuedEditHint(),
    // Resolves Apple_Terminal's ambiguous plain return; null keeps plain submit.
    private readonly shiftReturnReader: (() => boolean) | null = appleTerminalShiftReader(),
    // Round-trips the buffer through $EDITOR; returns null when the edit was abandoned.
    private readonly openExternalEditor: (text: string) => string | null = editPromptExternally,
  ) {}

  mount(ctx: StringViewContext): void {
    this.unmount();
    this.context = ctx;
    this.keyword.mount();
    this.draft.syncFromStore();
    this.publishEditorMode();
    this.unsub = promptStore.subscribe(() => this.syncFromStore());
    // The caret dims when the window loses attention and during panel navigation, so
    // the prompt repaints on both rather than waiting for a neighbour to request a frame.
    this.unsubAttention = windowAttentionStore.subscribe(() => ctx.requestRender());
    this.unsubView = appStore.subscribe(() => ctx.requestRender());
    ctx.pushFocus(this);
    ctx.requestRender();
  }

  unmount(): void {
    this.voice.dispose();
    this.emptyEscape.clear();
    this.notices.dispose();
    this.paste.dispose();
    this.unsub?.();
    this.unsub = undefined;
    this.unsubAttention?.();
    this.unsubAttention = undefined;
    this.keyword.unmount();
    this.unsubView?.();
    this.unsubView = undefined;
    this.context?.popFocus(this);
    this.context = undefined;
    this.draft.releaseBashMode();
    this.search.close();
    setPromptEditorMode(null);
  }

  /**
   * The mode the status row announces. Published when a key may have changed it
   * rather than while painting: the row is a separate component, and a value
   * written mid-paint reaches it a frame late.
   */
  private publishEditorMode(): void {
    setPromptEditorMode(editorModeAnnouncement(this.vim.indicatorMode()));
  }

  private caretIsLit(): boolean {
    if (!windowAttentionStore.getState().active) return false;
    const focused = this.context?.currentFocus?.();
    // The command menu owns the arrows while it is open, but typing still lands
    // in the prompt, so the caret stays lit under it.
    if (focused !== undefined && focused !== this && !promptStore.getState().menuOpen) {
      return false;
    }
    if (this.search.isOpen()) return false;
    const view = appStore.getState().view;
    return !view.panelFocused && !view.bgPillFocused;
  }

  getText(): string {
    return this.draft.getText();
  }

  getCaretOffset(): number {
    return this.draft.getCaretOffset();
  }

  isBashMode(): boolean {
    return this.draft.isBashMode();
  }

  /** True when the prompt holds no text, so an interrupt may fall through to the
   * turn/exit/rewind ladder instead of clearing an edit. */
  isEmpty(): boolean {
    return this.draft.isEmpty();
  }

  /** The mention picker lands its insertions the way typing does. */
  applyEdit(edit: PromptEdit | null, options?: { keepHistoryRun?: boolean }): void {
    this.draft.applyEdit(edit, options);
  }

  render(width: number): string[] {
    this.draft.setColumns(width);
    const frame = promptFrame({
      width,
      text: this.draft.getText(),
      caret: this.draft.getCaretOffset(),
      bashMode: this.draft.isBashMode(),
      caretLit: this.caretIsLit(),
      searchOpen: this.search.isOpen(),
      queuedEditHint: this.queuedEditHint,
      queuedEditHintShown: this.queuedEditHintShown,
      history: this.draft.history(),
      voice: this.voice,
      selection: this.vim.selection(),
      keywordTrigger: this.keyword.triggerEnabled(),
      keywordDismissed: this.keyword.dismissed(),
    });
    this.caretPosition = frame.caret;
    this.queuedEditHintShown = frame.queuedEditHintShown;
    return frame.rows;
  }

  /**
   * The terminal composes dead keys itself and draws the pending accent at the real
   * cursor, so the frame has to leave it here even though the visible caret is drawn
   * in software. Resolved during render, where the wrapped rows already exist.
   */
  caret(): CaretPosition | null {
    return this.caretPosition;
  }

  handleKey(key: KeyEventData): boolean | void {
    if (this.search.isOpen()) {
      this.search.handleKey(key);
      return true;
    }
    // Anything but another Escape puts the armed clear away, the way the host's
    // twice-to-exit hint yields to whatever is typed next.
    if (key.name !== "escape" && this.notices.isClearArmed()) this.notices.disarmClear();
    // The footer's transient row is done being read once a delete key lands; the key
    // keeps its editing job, it only takes the row with it.
    if (isFooterNoticeDismissKey(key)) {
      const footer = promptStore.getState();
      if (footer.notice !== null) this.notices.clear();
      if (footer.pasteExpandHint) this.paste.hideExpandHint();
    }
    if (key.isPasted) {
      this.paste.insert(key.sequence ?? "");
      return true;
    }
    // The hold machine sees every key: space presses may engage push-to-talk,
    // Escape cancels an active capture, and any other key resets its burst.
    if (
      this.voice.handleKey(key, {
        slashOpen: promptStore.getState().menuOpen,
        suspended: this.draft.isBashMode(),
      })
    ) {
      return true;
    }
    if (key.ctrl && key.name === "v" && this.paste.insertClipboardImage()) return true;
    if (key.ctrl && key.name === "s") {
      this.toggleStash();
      return true;
    }
    // Ctrl+G, or Ctrl+E finishing the Ctrl+X prefix, sends the draft out to $EDITOR.
    if (key.ctrl && (key.name === "g" || (key.name === "e" && takeCtrlXChord()))) {
      this.editExternally();
      return true;
    }
    // Ctrl+C / Esc first clear a non-empty prompt (the edit is discarded in place);
    // only an empty prompt lets the key bubble to the interrupt/exit/rewind ladder.
    if (key.ctrl && key.name === "c") {
      if (this.draft.isEmpty()) return false;
      this.clearInput();
      return true;
    }
    if (key.ctrl && key.name === "_") {
      this.draft.undoLastEdit();
      return true;
    }
    // Suspending the process belongs to the host, which owns the terminal modes.
    if (key.ctrl && key.name === "z") return false;
    // The editor mode must see Escape before the clear ladder arms it, and must
    // not see the chords above, which keep their own editing meaning.
    const tookKey = this.vim.handleKey(key);
    this.publishEditorMode();
    if (tookKey) return true;
    if (
      key.name === "escape" &&
      exitsBashMode({ cursor: this.draft.getCaretOffset(), bashMode: this.draft.isBashMode() })
    ) {
      this.draft.setBashMode(false);
      return true;
    }
    // A draft is only ever cleared on purpose: the first Escape arms and says so,
    // the second inside the window discards it.
    if (key.name === "escape" && !this.draft.isEmpty()) {
      if (this.notices.isClearArmed()) {
        this.clearInput();
        return true;
      }
      this.notices.armClear();
      this.notices.show(ESCAPE_CLEAR_NOTICE);
      return true;
    }
    if (key.name === "escape" && this.onEmptyDoubleEscape !== undefined) {
      if (this.emptyEscape.isArmed()) {
        this.emptyEscape.clear();
        this.onEmptyDoubleEscape();
        return true;
      }
      this.emptyEscape.arm();
      return true;
    }

    const keyName = effectivePromptKeyName(key);
    if (!continuesKillChain(key, keyName)) interruptKillChain();

    const panel = promptPanelFor(key, { keyName });
    if (panel !== null) {
      openPromptPanel(panel);
      return true;
    }

    if (key.ctrl && key.name === "r") {
      // The search chip wants the status row it would otherwise share with a notice.
      this.notices.clear();
      this.search.open(this.draft.getText(), this.draft.getCaretOffset());
      return;
    }
    const editShortcut = promptEditShortcut({
      key,
      keyName,
      text: this.draft.getText(),
      caret: this.draft.getCaretOffset(),
      columns: this.draft.getColumns(),
    });
    if (editShortcut !== null) return this.applyEditShortcut(editShortcut);

    return this.handleNamedKey(key);
  }

  /** The navigation and editing keys the readline layer answers by name. */
  private handleNamedKey(key: KeyEventData): boolean | void {
    const text = this.draft.getText();
    const caret = this.draft.getCaretOffset();
    const byWord = key.option || key.meta;
    switch (key.name) {
      case "enter":
        this.draft.insert("\n");
        return;
      case "return":
        if (caret > 0 && text[caret - 1] === "\\") this.draft.insertContinuedLine();
        else if (key.shift || key.meta || key.sequence === "\x1bOM") this.draft.insert("\n");
        else if (
          this.shiftReturnReader !== null &&
          isAppleTerminalShiftReturn(key, this.shiftReturnReader)
        )
          this.draft.insert("\n");
        else this.submit();
        return;
      case "backspace":
        if (exitsBashMode({ cursor: caret, bashMode: this.draft.isBashMode() })) {
          this.draft.setBashMode(false);
          return;
        }
        this.draft.applyEdit(deletePrevGraphemeEdit(text, caret));
        return;
      case "delete":
        this.draft.applyEdit(deleteNextGraphemeEdit(text, caret));
        return;
      case "up": {
        const restored = text.length === 0 ? this.onRestoreQueued?.() : null;
        if (restored !== null && restored !== undefined) {
          this.draft.applyStoredValue(restored);
          return;
        }
        this.draft.moveVertically("up");
        return;
      }
      case "down":
        this.draft.moveVertically("down");
        return;
      case "left":
        this.draft.moveTo(
          byWord ? prevWordBoundary(text, caret) : prevGraphemeBoundary(text, caret),
        );
        return;
      case "right":
        this.draft.moveTo(
          byWord ? nextWordBoundary(text, caret) : nextGraphemeBoundary(text, caret),
        );
        return;
      case "home":
        this.draft.moveTo(visualLineStartOffset(text, caret, this.draft.getColumns()));
        return;
      case "end":
        this.draft.moveTo(visualLineEndOffset(text, caret, this.draft.getColumns()));
        return;
    }
    const sequence = key.sequence;
    if (!key.ctrl && !key.meta && sequence !== undefined && isInsertable(sequence)) {
      if (
        entersBashMode({
          key: sequence,
          buffer: text,
          cursor: caret,
          bashMode: this.draft.isBashMode(),
        })
      ) {
        this.draft.setBashMode(true);
        return;
      }
      this.draft.insert(sequence.normalize("NFC"));
    }
  }

  private submit(): void {
    const stored = this.draft.storedValue();
    if (this.draft.isBashMode() && this.draft.getText().trim().length === 0) return;
    this.notices.clear();
    this.onSubmit?.(stored);
    this.draft.remember(stored);
    this.draft.leaveHistory();
    if (this.draft.isBashMode()) this.draft.setBashMode(false);
    this.draft.setText("", 0);
    this.draft.resetUndo();
  }

  /** Double-space submit of a dictated transcript; the hold machine clears the buffer. */
  private submitVoiceTranscript(text: string): void {
    if (text.trim().length === 0) return;
    this.onSubmit?.(text);
    this.draft.remember(text);
    this.draft.leaveHistory();
  }

  /** Discards the current edit and any history position — the Ctrl+C/Esc clear step. */
  private clearInput(): void {
    this.notices.disarmClear();
    if (this.draft.isBashMode()) this.draft.setBashMode(false);
    this.search.close();
    this.draft.leaveHistory();
    this.draft.setText("", 0);
  }

  /** Ctrl+S: park the draft in the single slot, or take the parked one back. */
  private toggleStash(): void {
    const result = this.stash.toggle({
      text: this.draft.getText(),
      caret: this.draft.getCaretOffset(),
    });
    if (result.kind === "none") return;
    this.draft.leaveHistory();
    this.draft.setText(result.draft.text, result.draft.caret);
    this.notices.show(result.kind === "stashed" ? STASHED_NOTICE : RESTORED_NOTICE);
  }

  /** Ctrl+G / Ctrl+X Ctrl+E: whatever the editor saved becomes the buffer. */
  private editExternally(): void {
    const edited = this.openExternalEditor(this.draft.getText());
    if (edited === null || edited === this.draft.getText()) return;
    this.draft.leaveHistory();
    this.draft.setText(edited, edited.length);
  }

  private applyEditShortcut(shortcut: PromptEditShortcut): boolean | void {
    switch (shortcut.kind) {
      case "edit":
        this.draft.applyEdit(shortcut.edit, {
          keepHistoryRun: shortcut.keepHistoryRun === true,
        });
        return;
      case "kill":
        this.applyKill(shortcut.edit);
        return;
      case "move":
        this.draft.moveTo(shortcut.caret);
        return;
      case "history-up":
        this.draft.moveVertically("up");
        return;
      case "history-down":
        this.draft.moveVertically("down");
        return;
      case "toggle-keyword":
        this.keyword.toggleDismissal();
        return;
      case "bubble":
        return false;
    }
  }

  /**
   * A kill lands like any other edit and then says where the text went: the ring
   * holds it, and the row names the key that pastes it back.
   */
  private applyKill(edit: PromptEdit | null): void {
    if (edit === null) return;
    this.draft.applyEdit(edit);
    this.notices.show(YANK_NOTICE);
  }

  private syncFromStore(): void {
    if (this.draft.syncFromStore()) this.context?.requestRender();
  }
}

export { createQueuedEditHint } from "@/ui/input/queued-edit-hint.ts";
