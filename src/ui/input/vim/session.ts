import { loadConfigSync } from "@/kernel/config/config.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { isInsertable } from "@/ui/chrome/key-input.ts";
import { prevGraphemeBoundary } from "@/ui/input/prompt-text.js";
import { logicalLineDown } from "@/ui/input/vim/boundaries.ts";
import { MAX_MOTION_COUNT } from "@/ui/input/vim/constants.ts";
import { replaceGrapheme, replaceSpan, runOperator, type VimEdit } from "@/ui/input/vim/edit.ts";
import { lineSpan, motionForOperator, motionRange, resolveMotion } from "@/ui/input/vim/motion.ts";
import { classifyNormalKey, motionAfterGPrefix, operatorStep } from "@/ui/input/vim/normal.ts";
import { ChangeRecorder, replayChange } from "@/ui/input/vim/repeat.ts";
import { textObject } from "@/ui/input/vim/span.ts";
import type {
  SearchDirection,
  VimBuffer,
  VimFind,
  VimMode,
  VimMotion,
  VimOperator,
  VimPending,
  VimRange,
  VimRegister,
  VimSettings,
  VisualSpan,
} from "@/ui/input/vim/types.ts";
import { selectionRange, visualAction, visualEntry } from "@/ui/input/vim/visual.ts";

export function vimSettingsFromConfig(): VimSettings {
  const config = loadConfigSync();
  return {
    enabled: config.editorMode === "vim",
    indicatorHidden: config.statusline?.hideVimModeIndicator === true,
  };
}

/**
 * The stateful facade the prompt talks to. It owns which mode the input is in
 * and answers whether a key belonged to that mode; everything the key does to
 * the text goes through the buffer it was handed.
 */
export class VimSession {
  private mode: VimMode = { name: "insert" };
  /** The count under construction, or null when no digit has been typed. */
  private count: number | null = null;
  private pending: VimPending = { kind: "none" };
  /** The last character search, which `;` and `,` replay. */
  private lastFind: VimFind | undefined;
  /** The one unnamed register. Empty until something is taken. */
  private register: VimRegister = { text: "", linewise: false };
  /** Where a visual selection was started; null outside visual. */
  private anchor: number | null = null;
  private readonly changes = new ChangeRecorder();

  constructor(
    private readonly buffer: VimBuffer,
    private readonly settings: VimSettings = vimSettingsFromConfig(),
  ) {}

  isEnabled(): boolean {
    return this.settings.enabled;
  }

  currentMode(): VimMode {
    return this.mode;
  }

  /**
   * The mode worth showing below the prompt, or null when nothing should be.
   * Normal is deliberately silent — the indicator marks the modes that change
   * what typing does, and normal is where the reader already expects to be.
   */
  indicatorMode(): VimMode | null {
    if (!this.settings.enabled || this.settings.indicatorHidden) return null;
    return this.mode.name === "normal" ? null : this.mode;
  }

  /**
   * The span to paint as selected, or null when nothing is. The prompt asks every
   * render, so this reads state rather than computing anything the mode owns.
   */
  selection(): { start: number; end: number } | null {
    if (this.mode.name !== "visual" || this.anchor === null) return null;
    const range = selectionRange(
      this.buffer.getText(),
      this.anchor,
      this.buffer.getCaretOffset(),
      this.mode.span,
    );
    return { start: range.start, end: range.end };
  }

  /** True when the key belonged to the mode machine and must travel no further. */
  handleKey(key: KeyEventData): boolean {
    if (!this.settings.enabled) return false;
    // A chord keeps its editing meaning in every mode, so it passes straight
    // through to the handlers that own it.
    if (key.ctrl || key.meta) return false;
    if (key.name === "escape") return this.handleEscape();
    if (this.mode.name === "insert") return false;
    // Typing fast enough delivers several characters in one event. In insert that
    // is still one insertion, but outside it every character is its own command,
    // so `dw` arriving together has to act as `d` then `w` rather than as one key
    // the table cannot name.
    const sequence = key.sequence;
    if (sequence !== undefined && sequence.length > 1 && isInsertable(sequence)) {
      let handled = false;
      for (const character of sequence) {
        if (this.handleKey({ ...key, name: character, sequence: character })) handled = true;
      }
      return handled;
    }
    // Tracked here and nowhere else: visual hands its shared keys to the normal
    // handler, so tracking in both ladders would count those keys twice. A command
    // starts on the first key typed with nothing half-composed, and visual is one
    // long command, so its selection keys join the same run.
    if (sequence !== undefined && isInsertable(sequence)) {
      const halfTyped =
        this.count !== null || this.pending.kind !== "none" || this.mode.name === "visual";
      this.changes.track(sequence, halfTyped);
    }
    if (this.mode.name === "visual") return this.handleVisualKey(key);
    return this.handleNormalKey(key);
  }

  /**
   * Escape leaves insert and is the one key that always may. In normal there is
   * no mode to leave, so it falls through to the prompt's own escape ladder —
   * arming the clear, then discarding the draft.
   */
  private handleEscape(): boolean {
    if (this.mode.name === "visual") {
      // Escape drops the selection and stays in the mode machine; a second one
      // then reaches the prompt's own ladder, which is the two-stage exit.
      this.leaveVisual();
      return true;
    }
    if (this.mode.name !== "insert") {
      // A half-typed command is what Escape cancels here, and cancelling it is
      // an action, so the key is spent. With nothing half-typed there is nothing
      // to cancel and the prompt's ladder gets the key — otherwise the draft
      // could never be cleared from normal mode.
      if (this.count === null && this.pending.kind === "none") return false;
      this.count = null;
      this.pending = { kind: "none" };
      return true;
    }
    const text = this.buffer.getText();
    const caret = this.buffer.getCaretOffset();
    this.mode = { name: "normal" };
    this.count = null;
    this.pending = { kind: "none" };
    this.changes.settleTrailer(text, caret);
    // Leaving insert steps back onto the character just typed, unless the caret
    // sits at the start of the buffer or of a line, where there is none.
    const stepsBack = caret > 0 && text[caret - 1] !== "\n";
    this.buffer.moveTo(stepsBack ? prevGraphemeBoundary(text, caret) : caret);
    return true;
  }

  private handleNormalKey(key: KeyEventData): boolean {
    const typed = key.sequence;
    // A named key with no printable sequence — enter, an arrow, a page key —
    // keeps the meaning the prompt already gives it.
    if (typed === undefined || !isInsertable(typed)) return false;

    // A parked prefix gets first refusal on the key that follows it, and is spent
    // either way: a `g` that nothing completes is over, not still waiting.
    const pending = this.pending;
    this.pending = { kind: "none" };
    if (pending.kind === "findTarget") {
      return this.applyFind({ target: typed, direction: pending.direction, stop: pending.stop });
    }
    if (pending.kind === "gPrefix") {
      const motion = motionAfterGPrefix(typed);
      return motion === null ? true : this.applyMotion(motion);
    }
    if (pending.kind === "replaceTarget") {
      const count = this.takeCount();
      this.changes.commit(false, this.buffer.getText(), this.buffer.getCaretOffset());
      return this.applyEdit(
        replaceGrapheme(this.buffer.getText(), this.buffer.getCaretOffset(), typed),
      );
    }
    if (pending.kind === "operator") return this.continueOperator(pending, typed);

    const classified = classifyNormalKey(typed, () => this.register);
    switch (classified.kind) {
      case "digit":
        return this.applyDigit(classified.digit);
      case "motion":
        return this.applyMotion(classified.motion);
      case "gPrefix":
        this.pending = { kind: "gPrefix" };
        return true;
      case "awaitFindTarget":
        this.pending = {
          kind: "findTarget",
          direction: classified.direction,
          stop: classified.stop,
        };
        return true;
      case "repeatFind":
        return this.applyRepeatFind(classified.flipped);
      case "enterInsert":
        this.count = null;
        return this.enterInsert(classified.at(this.buffer.getText(), this.buffer.getCaretOffset()));
      case "operator": {
        const count = this.count;
        this.count = null;
        this.pending = {
          kind: "operator",
          operator: classified.operator,
          count,
          gPrefix: false,
          find: null,
          objectAround: null,
        };
        return true;
      }
      case "operatorToLineEnd":
        return this.applyOperator(classified.operator, { kind: "lineEnd" }, this.takeCount());
      case "caretEdit": {
        const count = this.takeCount();
        const edit = classified.edit(
          this.buffer.getText(),
          this.buffer.getCaretOffset(),
          count ?? 1,
        );
        const applied = classified.takes ? this.applyTakingEdit(edit) : this.applyEdit(edit);
        if (classified.entersInsert) this.mode = { name: "insert" };
        this.changes.commit(
          classified.entersInsert,
          this.buffer.getText(),
          this.buffer.getCaretOffset(),
        );
        return applied;
      }
      case "awaitReplaceTarget":
        this.pending = { kind: "replaceTarget" };
        return true;
      case "undo":
        this.count = null;
        this.buffer.undoLastEdit();
        return true;
      case "repeatChange": {
        const change = this.changes.lastChange();
        const count = this.takeCount();
        if (change === undefined || this.changes.isReplaying()) return true;
        this.changes.replay(() =>
          replayChange(change, count, (replayed) => this.handleKey(replayed), this.buffer),
        );
        // A replay leaves the mode where it found it: the recorded keys may have
        // opened insert or a selection, and neither belongs to the reader now.
        this.mode = { name: "normal" };
        this.anchor = null;
        this.pending = { kind: "none" };
        this.count = null;
        return true;
      }
      case "unbound": {
        const span = visualEntry(typed);
        if (span !== null) return this.enterVisual(span);
        // A printable key this mode does not implement is still swallowed:
        // letting it through would type a letter that reads as a command.
        this.count = null;
        return true;
      }
    }
  }

  private enterVisual(span: VisualSpan): boolean {
    this.count = null;
    this.anchor = this.buffer.getCaretOffset();
    this.mode = { name: "visual", span };
    this.buffer.moveTo(this.anchor);
    return true;
  }

  private leaveVisual(): void {
    this.mode = { name: "normal" };
    this.anchor = null;
    this.count = null;
    this.pending = { kind: "none" };
  }

  /**
   * VISUAL shares every motion with NORMAL — a motion moves the selection's own
   * moving edge — and adds the keys that act on what is selected. The table says
   * what a key means; this performs it. Anything unknown is swallowed, as in NORMAL.
   */
  private handleVisualKey(key: KeyEventData): boolean {
    const typed = key.sequence;
    if (typed === undefined || !isInsertable(typed)) return false;
    const anchor = this.anchor;
    if (anchor === null) {
      this.leaveVisual();
      return true;
    }
    const parked = this.resumeVisualPending(typed, anchor);
    if (parked !== null) return parked;

    const action = visualAction(typed, this.register);
    switch (action.kind) {
      case "edit": {
        const applied = this.mapSelection(anchor, action.edit);
        if (action.entersInsert) this.mode = { name: "insert" };
        this.changes.commit(
          action.entersInsert,
          this.buffer.getText(),
          this.buffer.getCaretOffset(),
        );
        return applied;
      }
      case "span":
        if (this.mode.name === "visual" && this.mode.span === action.span) this.leaveVisual();
        else this.mode = { name: "visual", span: action.span };
        return true;
      case "swapEnds":
        this.anchor = this.buffer.getCaretOffset();
        this.buffer.moveTo(anchor);
        return true;
      case "awaitReplaceTarget":
        this.pending = { kind: "replaceTarget" };
        return true;
      case "awaitObject":
        this.pending = {
          kind: "operator",
          operator: "delete",
          count: null,
          gPrefix: false,
          find: null,
          objectAround: action.around,
        };
        return true;
      case "shareWithNormal":
        return this.handleNormalKey(key);
      case "ignored":
        this.count = null;
        return true;
    }
  }

  /**
   * A key that VISUAL parked earlier — a search target, a `g`, a replacement, an
   * object. Null when nothing was parked, so the caller reads the key fresh.
   */
  private resumeVisualPending(typed: string, anchor: number): boolean | null {
    const pending = this.pending;
    if (pending.kind === "none") return null;
    this.pending = { kind: "none" };
    if (pending.kind === "findTarget") {
      const find: VimFind = { target: typed, direction: pending.direction, stop: pending.stop };
      this.lastFind = find;
      return this.applyMotion({ kind: "find", ...find });
    }
    if (pending.kind === "gPrefix") {
      const motion = motionAfterGPrefix(typed);
      return motion === null ? true : this.applyMotion(motion);
    }
    if (pending.kind === "replaceTarget") {
      const replaced = this.mapSelection(anchor, (text, range) => replaceSpan(text, range, typed));
      this.changes.commit(false, this.buffer.getText(), this.buffer.getCaretOffset());
      return replaced;
    }
    // The only operator VISUAL parks is an object prefix; nothing else can be here.
    if (pending.objectAround !== null) return this.selectObject(typed, pending.objectAround);
    return true;
  }

  /** Widens the selection to a text object, keeping the mode. */
  private selectObject(typed: string, around: boolean): boolean {
    const span = textObject(this.buffer.getText(), this.buffer.getCaretOffset(), typed, around);
    if (span === null) return true;
    this.anchor = span.start;
    this.buffer.moveTo(Math.max(span.start, span.end - 1));
    return true;
  }

  /** Runs an edit over the selection, then leaves the mode as vim does. */
  private mapSelection(anchor: number, edit: (text: string, range: VimRange) => VimEdit): boolean {
    const range = this.currentSelection(anchor);
    const applied = this.applyTakingEdit(edit(this.buffer.getText(), range));
    this.leaveVisual();
    return applied;
  }

  private currentSelection(anchor: number): VimRange {
    const span = this.mode.name === "visual" ? this.mode.span : "characterwise";
    return selectionRange(this.buffer.getText(), anchor, this.buffer.getCaretOffset(), span);
  }

  /**
   * The key after an operator. Its own key again makes the operator linewise
   * (`dd`), a `g` or a find parks one more step, and a motion completes it. The
   * two counts multiply, which is what `2d3w` means.
   */
  private continueOperator(
    pending: Extract<VimPending, { kind: "operator" }>,
    typed: string,
  ): boolean {
    const total = combinedCount(pending.count, this.count);
    if (pending.objectAround !== null) {
      this.count = null;
      const span = textObject(
        this.buffer.getText(),
        this.buffer.getCaretOffset(),
        typed,
        pending.objectAround,
      );
      // A key that names no object, or an object the caret is not inside, leaves
      // the draft alone — the operator is spent either way.
      if (span === null) return true;
      return this.applyOperatorToRange(pending.operator, span);
    }
    if (pending.find !== null) {
      const find: VimFind = { target: typed, ...pending.find };
      this.lastFind = find;
      return this.applyOperator(pending.operator, { kind: "find", ...find }, total);
    }
    if (pending.gPrefix) {
      const motion = motionAfterGPrefix(typed);
      this.count = null;
      return motion === null ? true : this.applyOperator(pending.operator, motion, total);
    }
    const step = operatorStep(typed, pending.operator);
    switch (step.kind) {
      case "lines":
        this.count = null;
        return this.applyLinewiseOperator(pending.operator, total ?? 1);
      case "motion":
        this.count = null;
        return this.applyOperator(pending.operator, step.motion, total);
      case "digit":
        // A count typed after the operator keeps the operator waiting.
        this.pending = pending;
        return this.applyDigit(step.digit);
      case "repeatFind": {
        this.count = null;
        const last = this.lastFind;
        if (last === undefined) return true;
        const direction = step.flipped ? flipDirection(last.direction) : last.direction;
        return this.applyOperator(
          pending.operator,
          { kind: "find", target: last.target, direction, stop: last.stop },
          total,
        );
      }
      case "park":
        this.count = null;
        this.pending =
          step.park === "gPrefix"
            ? { ...pending, gPrefix: true, count: total }
            : "find" in step.park
              ? { ...pending, count: total, find: step.park.find }
              : { ...pending, count: total, objectAround: step.park.objectAround };
        return true;
      case "abandon":
        this.count = null;
        return true;
    }
  }

  private applyOperator(operator: VimOperator, motion: VimMotion, count: number | null): boolean {
    const text = this.buffer.getText();
    const caret = this.buffer.getCaretOffset();
    const range = motionRange({
      text,
      caret,
      columns: this.buffer.getColumns(),
      motion: motionForOperator(operator, motion, text, caret),
      count,
    });
    // A motion that covers nothing leaves the draft alone, but the key still
    // belonged to the mode.
    if (range === null) return true;
    return this.applyOperatorToRange(operator, range);
  }

  private applyOperatorToRange(operator: VimOperator, range: VimRange): boolean {
    const applied = this.applyTakingEdit(runOperator(operator, this.buffer.getText(), range));
    // Change is the one operator that ends somewhere else: it takes the span and
    // leaves the caret in insert, where the replacement is typed.
    if (operator === "change") this.mode = { name: "insert" };
    // Recorded after the edit: a change waiting for its insert trailer compares
    // the buffer against the moment insert opened, not the moment the key landed.
    this.changes.commit(operator === "change", this.buffer.getText(), this.buffer.getCaretOffset());
    return applied;
  }

  /** `dd` and friends: whole lines from the caret's own, `count` of them. */
  private applyLinewiseOperator(operator: VimOperator, count: number): boolean {
    const text = this.buffer.getText();
    const caret = this.buffer.getCaretOffset();
    let last = caret;
    for (let i = 1; i < count; i += 1) {
      const down = logicalLineDown(text, last);
      if (down === null) break;
      last = down;
    }
    return this.applyOperatorToRange(operator, lineSpan(text, caret, last));
  }

  /** Applies an edit and keeps whatever it took, so the register is one place. */
  private applyTakingEdit(edit: VimEdit): boolean {
    if (edit.taken !== undefined) this.register = edit.taken;
    return this.applyEdit(edit);
  }

  private applyEdit(edit: VimEdit): boolean {
    if (edit.text === this.buffer.getText()) {
      // Nothing changed, so nothing is recorded as an undo step — but the caret
      // may still have been asked to move, as a yank does.
      this.buffer.moveTo(edit.caret);
      return true;
    }
    this.buffer.applyEdit({ text: edit.text, caret: edit.caret });
    return true;
  }

  private takeCount(): number | null {
    const count = this.count;
    this.count = null;
    return count;
  }

  /**
   * A digit joins the count under construction. `0` with no count open is the
   * line-start motion instead — the one key whose meaning depends on what came
   * before it.
   */
  private applyDigit(digit: number): boolean {
    if (digit === 0 && this.count === null) return this.applyMotion({ kind: "lineStart" });
    this.count = Math.min((this.count ?? 0) * 10 + digit, MAX_MOTION_COUNT);
    return true;
  }

  private applyMotion(motion: VimMotion): boolean {
    const count = this.count;
    this.count = null;
    const landed = resolveMotion({
      text: this.buffer.getText(),
      caret: this.buffer.getCaretOffset(),
      columns: this.buffer.getColumns(),
      motion,
      count,
    });
    // A motion that cannot move still belongs to the mode. Declining the key
    // would hand `h` at the start of a line to the readline editor, which moves
    // the caret somewhere the reader did not ask for.
    if (landed !== null) this.buffer.moveTo(landed);
    return true;
  }

  private applyFind(find: VimFind): boolean {
    this.lastFind = find;
    return this.applyMotion({ kind: "find", ...find });
  }

  private applyRepeatFind(flipped: boolean): boolean {
    const last = this.lastFind;
    // Nothing has been searched for yet, so there is nothing to repeat — and the
    // count, if one was typed, is spent rather than left to bind to the next key.
    if (last === undefined) {
      this.count = null;
      return true;
    }
    const direction = flipped ? flipDirection(last.direction) : last.direction;
    // A repeat does not become the new search: `,` then `;` goes back the way
    // `,` went, it does not keep flipping.
    return this.applyMotion({ kind: "find", target: last.target, direction, stop: last.stop });
  }

  private enterInsert(caret: number): boolean {
    this.mode = { name: "insert" };
    this.buffer.moveTo(caret);
    return true;
  }
}

/**
 * A count before the operator and one after it multiply — `2d3w` covers six
 * words. Either being absent leaves the other alone, and both absent stays absent
 * so a motion can still tell "no count" from "one".
 */
function combinedCount(before: number | null, after: number | null): number | null {
  if (before === null) return after;
  if (after === null) return before;
  return Math.min(before * after, MAX_MOTION_COUNT);
}

function flipDirection(direction: SearchDirection): SearchDirection {
  return direction === "forward" ? "backward" : "forward";
}
