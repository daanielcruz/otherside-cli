import { createAutoClearDispatch } from "@/kernel/std/state/auto-clear-dispatch.ts";
import { suspendToShell } from "@/terminal-runtime/host/process-suspend.js";
import {
  createRenderScheduler,
  type RenderScheduler,
} from "@/terminal-runtime/host/render-scheduler.js";
import {
  currentTerminalHandoff,
  publishTerminalHandoff,
  type TerminalHandoff,
} from "@/terminal-runtime/host/terminal-handoff.js";
import {
  recoverTerminal,
  registerTerminalRecovery,
} from "@/terminal-runtime/host/terminal-restoration.js";
import {
  decodeTerminalInput,
  FRESH_INPUT_DECODE_STATE,
  type InputDecodeState,
} from "@/terminal-runtime/input/key-decoder.js";
import type { StringComponent } from "@/terminal-runtime/string-view/component.js";
import { StringFocusStack } from "@/terminal-runtime/string-view/focus.js";
import {
  ExternalClearWatcher,
  shouldWatchExternalClears,
} from "@/terminal-runtime/string-view/host/external-clear-watch.js";
import { InlineRowPainter } from "@/terminal-runtime/string-view/row-emitter.js";
import { PASTE_END, PASTE_START } from "@/terminal-runtime/terminal/control-sequences.js";
import { CURSOR_DISPLAY_OFF, EBP, EFE } from "@/terminal-runtime/terminal/private-modes.js";

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
// A lone ESC is indistinguishable from the start of an escape sequence until the
// next byte arrives; without this idle flush a single Escape press stays pending in
// the parser (so panels never close on the first press). A partial bracketed-paste
// prefix gets the longer paste window before it resolves.
const AMBIGUOUS_INPUT_DELAY_MS = 50;
const PASTE_PREFIX_DELAY_MS = 500;
const PASTE_HINT_BYTES = 3;
/** How long a twice-to-exit chord stays armed before the hint gives up on it. */
export const EXIT_HINT_HOLD_MS = 800;
// Bracketed paste makes a multi-line paste arrive as one atomic event the prompt
// inserts verbatim, instead of a burst of newlines the parser reads as submits.
// Focus reporting (EFE) drives the focus-gain clipboard probe. `recoverTerminal`
// disables both (DBP/DFE) whenever the terminal goes back to the shell.
const OWNED_TERMINAL_MODES = CURSOR_DISPLAY_OFF + EBP + EFE;

/** The chords whose second press within the hint window leaves the session. */
export type ExitChord = "ctrl-c" | "ctrl-d";

function exitChordFor(key: { ctrl: boolean; name: string | undefined }): ExitChord | null {
  if (!key.ctrl) return null;
  if (key.name === "c") return "ctrl-c";
  if (key.name === "d") return "ctrl-d";
  return null;
}

export interface StringViewController {
  repaint: () => void;
  /**
   * Repaints as if nothing were on screen. The automatic watch only runs where
   * a cursor probe is trustworthy, so this is the way back on every other
   * terminal after something outside cleared it.
   */
  redraw: () => void;
  close: () => void;
  finished: () => Promise<void>;
}

export interface InlineSurfaceSessionOptions {
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  confirmInterruptExit?: boolean;
  // Notified when the twice-to-exit window arms or clears, so a UI component can
  // render the styled hint in place — the host stays free of product chrome.
  onExitHintChange?: (armed: boolean, chord: ExitChord) => void;
  // Static rows written once into scrollback above the live frame (the boot banner).
  // They scroll into history as the live frame grows and are re-emitted on resize,
  // so they never enter the diffed live document. Returns [] to write nothing.
  prelude?: (width: number) => readonly string[];
  // Notified when DECSET 1004 reports window attention, so product surfaces can
  // refresh attention-sensitive state such as the clipboard-image hint.
  onWindowAttention?: (active: boolean) => void;
}

export function openStringView(
  root: StringComponent,
  options: InlineSurfaceSessionOptions = {},
): StringViewController {
  const session = new InlineSurfaceSession(root, options);
  session.open();
  return session.controller();
}

class InlineSurfaceSession {
  private readonly terminalOutput: NodeJS.WriteStream;
  private readonly terminalInput: NodeJS.ReadStream;
  private readonly confirmInterruptExit: boolean;
  private readonly painter = new InlineRowPainter();
  private scrollbackPresented = false;
  private readonly focus = new StringFocusStack();
  private readonly requestPaint: RenderScheduler;
  private readonly closeWaiters: (() => void)[] = [];
  private closed = false;
  private initialRawMode: boolean | undefined;
  private decoderState: InputDecodeState = { ...FRESH_INPUT_DECODE_STATE };
  private decoderDrainTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly exitConfirmation = createAutoClearDispatch<ExitChord>({
    holdMs: EXIT_HINT_HOLD_MS,
  });
  private readonly publishExitHint: (armed: boolean, chord: ExitChord) => void;
  private readonly openingRows: (width: number) => readonly string[];
  private readonly publishAttention: (active: boolean) => void;
  // Published while this session owns the terminal, so a suspend and an external
  // editor hand the screen over through the same pair.
  private readonly handoff: TerminalHandoff = {
    release: () => this.releaseTerminal(),
    reclaim: () => this.reclaimTerminal(),
  };
  // Cmd+R recovery: a cursor-position probe rides the input stream; the pending
  // resolver claims the CPR reply before the key decoder ever sees it.
  private clearWatcher: ExternalClearWatcher | null = null;
  private cursorProbe: {
    resolve: (row: number | undefined) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(
    private readonly root: StringComponent,
    options: InlineSurfaceSessionOptions,
  ) {
    this.terminalOutput = options.stdout ?? process.stdout;
    this.terminalInput = options.stdin ?? process.stdin;
    this.confirmInterruptExit = options.confirmInterruptExit ?? true;
    this.publishExitHint = options.onExitHintChange ?? (() => {});
    this.openingRows = options.prelude ?? (() => []);
    this.publishAttention = options.onWindowAttention ?? (() => {});
    this.requestPaint = createRenderScheduler(() => this.paintNow());
  }

  open(): void {
    registerTerminalRecovery();
    publishTerminalHandoff(this.handoff);
    this.terminalOutput.write(OWNED_TERMINAL_MODES);
    this.terminalOutput.on("resize", this.reflowToTerminal);
    this.listenForInput();
    this.startClearWatch();
    this.paintNow();
    this.root.mount?.({
      requestRender: () => this.requestPaint(),
      pushFocus: (target) => this.focus.push(target),
      popFocus: (target) => this.focus.pop(target),
      currentFocus: () => this.focus.current(),
      terminalRows: () => Math.max(0, this.terminalOutput.rows ?? DEFAULT_ROWS),
    });
  }

  controller(): StringViewController {
    return {
      repaint: () => this.requestPaint(),
      redraw: () => this.recoverFromExternalClear(),
      close: () => this.close(),
      finished: () =>
        new Promise<void>((resolve) => {
          if (this.closed) {
            resolve();
            return;
          }
          this.closeWaiters.push(resolve);
        }),
    };
  }

  /**
   * Resend the surface whole — opening rows, the settled archive, then the live
   * frame — with a destructive paint. The incremental path cannot stand in for
   * this: its batch carries only what settled since the last paint, so every row
   * committed before it would be missing from the rebuilt screen.
   */
  private regenerateSurface(): void {
    if (this.closed) return;
    const width = Math.max(1, this.terminalOutput.columns ?? DEFAULT_COLUMNS);
    const height = Math.max(0, this.terminalOutput.rows ?? DEFAULT_ROWS);
    const history = [...this.openingRows(width), ...(this.root.snapshotScrollback?.(width) ?? [])];
    const frame = this.root.render(width);
    const { bytes } = this.painter.paintScrollback(
      history,
      frame,
      { width, height, caret: this.root.caret?.(width) ?? null },
      true,
    );
    this.scrollbackPresented = true;
    if (bytes.length > 0) this.terminalOutput.write(bytes);
  }

  // A resize has already reflowed whatever the terminal was showing, so the screen
  // is regenerated from history rather than diffed against rows that moved.
  private readonly reflowToTerminal = (): void => {
    this.regenerateSurface();
  };

  private paintNow(): void {
    if (this.closed) return;
    const width = Math.max(1, this.terminalOutput.columns ?? DEFAULT_COLUMNS);
    const height = Math.max(0, this.terminalOutput.rows ?? DEFAULT_ROWS);
    const frame = this.root.render(width);
    const batch = this.root.takeScrollbackBatch?.(width) ?? { mode: "idle" };
    // Asked after render, so it reports the caret inside the frame just built.
    const geometry = { width, height, caret: this.root.caret?.(width) ?? null };
    let bytes: string;

    if (!this.scrollbackPresented || batch.mode === "reflow" || batch.mode === "switch") {
      const historyRows = batch.mode === "idle" ? [] : batch.rows;
      bytes = this.painter.paintScrollback(
        [...this.openingRows(width), ...historyRows],
        frame,
        geometry,
        // Committed rows are no longer addressable (the emitter rebases onto the
        // live frame), so replaying full history incrementally would append a
        // second copy below the first. Both a rewritten conversation (reflow)
        // and a surface ownership change (switch) regenerate the surface.
        batch.mode === "switch" || batch.mode === "reflow",
      ).bytes;
      this.scrollbackPresented = true;
    } else if (batch.mode === "add") {
      bytes = this.painter.commitScrollback(batch.rows, frame, geometry).bytes;
    } else {
      bytes = this.painter.emitFrame(frame, geometry).bytes;
    }

    if (bytes.length > 0) this.terminalOutput.write(bytes);
  }

  private listenForInput(): void {
    if (!this.terminalInput.isTTY) return;
    this.initialRawMode = this.terminalInput.isRaw;
    this.terminalInput.setRawMode?.(true);
    this.terminalInput.resume();
    this.terminalInput.on("data", this.acceptInput);
  }

  private readonly acceptInput = (chunk: Buffer): void => {
    const input = this.claimCursorReport(chunk);
    if (input === null) return;
    const [events, nextState] = decodeTerminalInput(this.decoderState, input);
    this.dispatchDecoded(events, nextState);
    this.deferIncompleteInput(nextState);
  };

  /** While a probe is pending, the CPR reply belongs to it, never to the decoder. */
  private claimCursorReport(chunk: Buffer): Buffer | null {
    if (this.cursorProbe === null) return chunk;
    const text = chunk.toString("utf8");
    const report = /\x1b\[(\d+);\d+R/.exec(text);
    if (report === null) return chunk;
    const probe = this.cursorProbe;
    this.cursorProbe = null;
    clearTimeout(probe.timer);
    probe.resolve(Number.parseInt(report[1] ?? "", 10) || undefined);
    const rest = text.slice(0, report.index) + text.slice(report.index + report[0].length);
    return rest.length > 0 ? Buffer.from(rest, "utf8") : null;
  }

  private dispatchDecoded(
    events: ReturnType<typeof decodeTerminalInput>[0],
    nextState: InputDecodeState,
  ): void {
    this.decoderState = nextState;
    for (const event of events) {
      if (event.kind === "focus") {
        this.publishAttention(event.focused);
        continue;
      }
      if (event.kind !== "key") continue;
      const armedChord = this.exitConfirmation.isArmed() ? this.exitConfirmation.pendingKey : null;
      this.exitConfirmation.clear();
      // Any key dismisses the armed hint; a second press of the same chord exits.
      if (armedChord !== null) this.publishExitHint(false, armedChord);
      const handledByRoot = this.root.handleKey?.(event) === true;
      const handled = handledByRoot || this.focus.route(event);
      if (handled) continue;
      if (event.ctrl && event.name === "z") {
        this.suspend();
        return;
      }
      const chord = exitChordFor(event);
      if (this.confirmInterruptExit && chord !== null) {
        if (armedChord === chord) {
          this.close();
          return;
        }
        this.exitConfirmation.arm({
          key: chord,
          onTimeout: () => {
            this.publishExitHint(false, chord);
            this.requestPaint();
          },
        });
        this.publishExitHint(true, chord);
      }
    }
    this.requestPaint();
  }

  /**
   * Ctrl+Z: hand the terminal back cooked, stop like any job-controlled process, and
   * retake the modes plus a regenerated frame once the shell foregrounds us again.
   */
  private suspend(): void {
    suspendToShell(this.handoff);
  }

  private releaseTerminal(): void {
    this.clearWatcher?.stop();
    this.dropCursorProbe();
    if (this.terminalInput.isTTY) this.terminalInput.setRawMode?.(this.initialRawMode ?? false);
    recoverTerminal();
  }

  private reclaimTerminal(): void {
    if (this.closed) return;
    if (this.terminalInput.isTTY) this.terminalInput.setRawMode?.(true);
    this.terminalOutput.write(OWNED_TERMINAL_MODES);
    // The shell owned the screen in the meantime, so the frame is rebuilt rather
    // than diffed against rows that are no longer there.
    this.reflowToTerminal();
    this.clearWatcher?.start();
  }

  private startClearWatch(): void {
    const enabled = shouldWatchExternalClears({
      stdoutIsTTY: this.terminalOutput.isTTY,
      termProgram: process.env.TERM_PROGRAM,
      disabled: process.env.OTHERSIDE_DISABLE_EXTERNAL_CLEAR_WATCHER,
    });
    if (!enabled || !this.terminalInput.isTTY) return;
    this.clearWatcher = new ExternalClearWatcher({
      querier: { requestCursorPosition: (timeoutMs) => this.requestCursorPosition(timeoutMs) },
      getExpectedCursorRow: () => this.painter.parkedScreenRow(),
      onScreenClear: () => this.recoverFromExternalClear(),
    });
    this.clearWatcher.start();
  }

  private requestCursorPosition(timeoutMs: number): Promise<number | undefined> {
    if (this.closed || this.cursorProbe !== null) return Promise.resolve(undefined);
    return new Promise<number | undefined>((resolve) => {
      const timer = setTimeout(() => {
        if (this.cursorProbe?.resolve === resolve) this.cursorProbe = null;
        resolve(undefined);
      }, timeoutMs);
      timer.unref?.();
      this.cursorProbe = { resolve, timer };
      this.terminalOutput.write("\x1b[6n");
    });
  }

  private dropCursorProbe(): void {
    if (this.cursorProbe === null) return;
    const probe = this.cursorProbe;
    this.cursorProbe = null;
    clearTimeout(probe.timer);
    probe.resolve(undefined);
  }

  /**
   * The terminal was cleared under us (host Cmd+R): every painted row is gone while
   * the frame memory still believes in it. Forget the memory, then resend the whole
   * surface, because the conversation the user lost is the settled archive and only
   * a full regenerate carries it.
   */
  private recoverFromExternalClear(): void {
    if (this.closed) return;
    this.painter.invalidateTerminalMemory();
    this.regenerateSurface();
  }

  // Resolves a lone ESC (or other partial sequence) after an idle window by feeding
  // the parser a null flush, so a single Escape emits without waiting on a next byte.
  private deferIncompleteInput(state: InputDecodeState): void {
    if (this.decoderDrainTimer) {
      clearTimeout(this.decoderDrainTimer);
      this.decoderDrainTimer = undefined;
    }
    if (state.pending === "" && state.phase !== "paste") return;
    const resemblesPasteBoundary =
      state.pending.length >= PASTE_HINT_BYTES &&
      (PASTE_START.startsWith(state.pending) || PASTE_END.startsWith(state.pending));
    const delay =
      state.phase === "paste" || resemblesPasteBoundary
        ? PASTE_PREFIX_DELAY_MS
        : AMBIGUOUS_INPUT_DELAY_MS;
    this.decoderDrainTimer = setTimeout(this.drainIncompleteInput, delay);
  }

  private readonly drainIncompleteInput = (): void => {
    this.decoderDrainTimer = undefined;
    if (this.closed) return;
    const [events, nextState] = decodeTerminalInput(this.decoderState, null);
    this.dispatchDecoded(events, nextState);
  };

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearWatcher?.stop();
    this.clearWatcher = null;
    this.dropCursorProbe();
    if (currentTerminalHandoff() === this.handoff) publishTerminalHandoff(null);
    this.exitConfirmation.clear();
    if (this.decoderDrainTimer) {
      clearTimeout(this.decoderDrainTimer);
      this.decoderDrainTimer = undefined;
    }
    this.requestPaint.cancel?.();
    this.terminalOutput.off("resize", this.reflowToTerminal);
    if (this.terminalInput.isTTY) {
      this.terminalInput.off("data", this.acceptInput);
      this.terminalInput.pause();
    }
    this.root.unmount?.();
    this.focus.clear();
    this.releaseTerminal();
    for (const notify of this.closeWaiters.splice(0)) notify();
  }
}
