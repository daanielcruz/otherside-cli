import {
  promptInputModeOf,
  stripBashPrefix,
  withPromptMode,
} from "@/engine/queue/turn/bash-input.ts";
import {
  getPromptText,
  promptStore,
  setPromptBashMode,
  setPromptText,
} from "@/store/prompt/index.ts";
import type { PromptEdit } from "@/ui/input/prompt-edit-ops.ts";
import { PromptHistoryRun } from "@/ui/input/prompt-history-run.ts";
import { verticalStep } from "@/ui/input/prompt-text.js";
import { PromptUndoHistory } from "@/ui/input/prompt-undo.ts";
import type { VimBuffer } from "@/ui/input/vim/types.ts";

const DEFAULT_PROMPT_COLUMNS = 80;

interface DraftHooks {
  requestRender: () => void;
  /** A replaced draft retires whatever hint described the one before it. */
  onReplaced: () => void;
}

/**
 * The draft being typed: its text, caret, bash flag, undo steps and history run,
 * and every operation that changes them. The surface around it mounts, paints and
 * routes keys; it never reaches past this to the text.
 *
 * Five consumers already spoke to the prompt this way before the draft had a name
 * — the editor mode through `VimBuffer`, plus the mention picker, paste, voice and
 * history search, each holding an apply-and-leave-history pair.
 */
export class PromptDraft implements VimBuffer {
  private text = getPromptText();
  private caretOffset = this.text.length;
  private columns = DEFAULT_PROMPT_COLUMNS;
  private bashMode = promptStore.getState().bashMode;
  private readonly historyRun = new PromptHistoryRun();
  private readonly undoHistory = new PromptUndoHistory();

  constructor(private readonly hooks: DraftHooks) {}

  getText(): string {
    return this.text;
  }

  getCaretOffset(): number {
    return this.caretOffset;
  }

  /** The width the last render measured; the row motions resolve against it. */
  getColumns(): number {
    return this.columns;
  }

  setColumns(width: number): void {
    this.columns = Math.max(1, width);
  }

  isBashMode(): boolean {
    return this.bashMode;
  }

  isEmpty(): boolean {
    return this.text.length === 0;
  }

  /** The run the frame draws its history position from. */
  history(): PromptHistoryRun {
    return this.historyRun;
  }

  /** What history stores: the text plus the mode it was typed in. */
  storedValue(): string {
    return withPromptMode(this.text, this.bashMode ? "bash" : "prompt");
  }

  remember(value: string): void {
    this.historyRun.remember(value);
  }

  leaveHistory(): void {
    this.historyRun.leave();
  }

  /** Places the caret and repaints; the editor mode drives every move through it. */
  moveTo(offset: number): void {
    this.caretOffset = Math.max(0, Math.min(offset, this.text.length));
    this.hooks.requestRender();
  }

  /**
   * Lands a buffer edit; every edit but a yank-pop leaves the history run. The modal
   * editor and the mention picker land theirs the same way.
   */
  applyEdit(edit: PromptEdit | null, options?: { keepHistoryRun?: boolean }): void {
    if (edit === null) return;
    if (options?.keepHistoryRun !== true) this.leaveHistory();
    this.setText(edit.text, edit.caret);
  }

  /** A vertical arrow: a display row inside the draft, or a step into history. */
  moveVertically(direction: "up" | "down"): void {
    const step = verticalStep(direction, this.text, this.caretOffset, this.columns);
    if (step.kind === "caret") {
      this.moveTo(step.offset);
      return;
    }
    const stored = this.storedValue();
    const value =
      direction === "up" ? this.historyRun.previous(stored) : this.historyRun.next(stored);
    if (value !== null) this.applyStoredValue(value);
  }

  applyStoredValue(stored: string): void {
    this.setBashMode(promptInputModeOf(stored) === "bash");
    const text = stripBashPrefix(stored);
    this.setText(text, text.length);
  }

  insert(data: string): void {
    if (data.length === 0) return;
    this.leaveHistory();
    const next = this.text.slice(0, this.caretOffset) + data + this.text.slice(this.caretOffset);
    this.setText(next, this.caretOffset + data.length);
  }

  insertContinuedLine(): void {
    this.leaveHistory();
    const start = this.caretOffset - 1;
    this.setText(
      this.text.slice(0, start) + "\n" + this.text.slice(this.caretOffset),
      this.caretOffset,
    );
  }

  setBashMode(bashMode: boolean): void {
    if (bashMode === this.bashMode) return;
    this.bashMode = bashMode;
    setPromptBashMode(bashMode);
    this.hooks.requestRender();
  }

  /** Leaving the surface drops bash mode here and in the store together. */
  releaseBashMode(): void {
    this.bashMode = false;
    if (promptStore.getState().bashMode) setPromptBashMode(false);
  }

  /** Rewinds the buffer one undo step, restoring both the text and the caret. */
  undoLastEdit(): void {
    const step = this.undoHistory.undo();
    if (step === null) return;
    this.leaveHistory();
    this.setText(step.text, step.caret, { track: false });
  }

  /** A sent prompt is gone: undo rewinds the next draft, never the last one. */
  resetUndo(): void {
    this.undoHistory.reset();
  }

  setText(text: string, caret: number, options?: { readonly track?: boolean }): void {
    if (options?.track !== false && text !== this.text) {
      this.undoHistory.record({ text: this.text, caret: this.caretOffset });
    }
    this.hooks.onReplaced();
    this.text = text;
    this.caretOffset = Math.max(0, Math.min(caret, text.length));
    setPromptText(text);
    this.hooks.requestRender();
  }

  /** Takes text pushed in from outside; answers whether anything moved. */
  syncFromStore(): boolean {
    const state = promptStore.getState();
    let changed = false;
    if (state.text !== this.text) {
      this.text = state.text;
      this.caretOffset = state.text.length;
      this.leaveHistory();
      // Text pushed in from outside replaces the draft, so its history goes with it.
      this.undoHistory.reset();
      changed = true;
    }
    if (state.bashMode !== this.bashMode) {
      this.bashMode = state.bashMode;
      changed = true;
    }
    return changed;
  }
}
