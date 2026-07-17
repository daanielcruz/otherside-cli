import { PureComponent, type ReactNode } from "react";
import { recordEventTimestamp } from "@/bootstrap/state.js";
import { EventEmitter } from "@/terminal-runtime/input/event-bus.js";
import { KeyStroke } from "@/terminal-runtime/input/input-signal.js";
import {
  INITIAL_PARSER_STATE,
  type InputEvent,
  notifyTerminalThemeNotify,
  parseInputSequence,
} from "@/terminal-runtime/input/key-decoder.js";
import { WindowActivityStateEvent } from "@/terminal-runtime/input/terminal-focus-signal.js";
import PointerLocationContext, {
  type PointerLocationUpdater,
} from "@/terminal-runtime/react/cursor-contract.js";
import { TerminalSizeContext } from "@/terminal-runtime/react/dimensions-context.js";
import ErrorPresentation from "@/terminal-runtime/react/error-view.js";
import { ViewportActivityProvider } from "@/terminal-runtime/react/focus-context.js";
import StdinContext from "@/terminal-runtime/react/input-stream-context.js";
import AppContext from "@/terminal-runtime/react/runtime-context.js";
import StaticFlushContext, {
  type StaticFlushEnqueuer,
} from "@/terminal-runtime/react/scrollback-context.js";
import { TimekeeperProvider } from "@/terminal-runtime/react/time-source.js";
import { TerminalProbe, xtversion } from "@/terminal-runtime/terminal/capability-probe.js";
import {
  DISABLE_KITTY_KEYBOARD,
  DISABLE_MODIFY_OTHER_KEYS,
  ENABLE_KITTY_KEYBOARD,
  ENABLE_MODIFY_OTHER_KEYS,
  FOCUS_IN,
  FOCUS_OUT,
  PASTE_END,
  PASTE_START,
} from "@/terminal-runtime/terminal/control-sequences.js";
import { getPaneFocused, setPaneFocused } from "@/terminal-runtime/terminal/focus-state.js";
import {
  CURSOR_DISPLAY_OFF,
  CURSOR_DISPLAY_ON,
  DBP,
  DFE,
  DISABLE_THEME_NOTIFY,
  EBP,
  EFE,
  ENABLE_THEME_NOTIFY,
  MOUSE_CAPTURE_OFF,
} from "@/terminal-runtime/terminal/private-modes.js";
import {
  setDetectedTerminalVersion,
  supportsAdvancedInput,
} from "@/terminal-runtime/terminal/runtime-channel.js";
import reconciler from "@/terminal-runtime/tree/react-adapter.js";
import { emitDiagnosticOutput } from "@/utils/debug.js";
import { deactivateInputLatch } from "@/utils/earlyInput.js";
import { isEnvTruthy } from "@/utils/envUtils.js";
import { runProcessSafely } from "@/utils/execFileNoThrow.js";
import { writeDebugError } from "@/utils/log.js";

const SUPPORTS_SUSPEND =
  process.platform !== "win32" && process.env.OTHERSIDE_SESSION_KIND !== "bg";

const STDIN_IDLE_THRESHOLD_MS = 5000;

type Props = {
  readonly children: ReactNode;
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly exitOnCtrlC: boolean;
  readonly onExit: (error?: Error) => void;
  readonly terminalColumns: number;
  readonly terminalRows: number;

  readonly onStdinResume?: () => void;
  readonly onStdinSuspend?: () => void;
  readonly onTerminalResume?: () => void;

  readonly terminalProbe?: TerminalProbe;

  readonly onCursorDeclaration?: PointerLocationUpdater;

  readonly onStaticFlush?: StaticFlushEnqueuer;
};

type JediTermInput = {
  lastWheelTime: number;
  lastWheelDownTime: number;
};

const JEDITERM_WHEEL_TO_ARROW_GAP_MS = 75;

const JEDITERM_PHANTOM_WHEELUP_MS = 250;

const JEDITERM_WHEEL_IDLE_MS = 200;

const ARROW_BURST_WINDOW_MS = 100;
const ARROW_BURST_THRESHOLD = 8;

let intellijBlocksRewordedDetected = false;
let scrollBugSurfaced = false;
let scrollAsArrowsDetected = false;
let scrollAsArrowsCount = 0;

function isJediTermEmulator(): boolean {
  return process.env.TERMINAL_EMULATOR === "JetBrains-JediTerm";
}

function clearScrollAsArrowsState(): void {
  scrollAsArrowsDetected = false;
  scrollAsArrowsCount = 0;
}

function markScrollAsArrowsDetected(): void {
  intellijBlocksRewordedDetected = true;
  scrollAsArrowsDetected = true;
  scrollAsArrowsCount++;
}

function isIntellijBlocksReworkedTerminal(): boolean {
  if (intellijBlocksRewordedDetected) return true;
  if (
    process.env.INTELLIJ_TERMINAL_COMMAND_BLOCKS_REWORKED !== undefined ||
    process.env.INTELLIJ_TERMINAL_COMMAND_BLOCKS !== undefined
  ) {
    intellijBlocksRewordedDetected = true;
    return true;
  }
  return false;
}

function createJediTermInput(): JediTermInput {
  return { lastWheelTime: 0, lastWheelDownTime: 0 };
}

function applyJediTermScrollFix(
  state: JediTermInput,
  items: InputEvent[],
  now: number,
  onScrollBugDetected: () => void,
): InputEvent[] {
  if (!isJediTermEmulator()) return items;
  let mutated: InputEvent[] | null = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.kind !== "key") {
      mutated?.push(item);
      continue;
    }
    if (item.name === "wheelup" || item.name === "wheeldown") {
      if (now - state.lastWheelTime > JEDITERM_WHEEL_IDLE_MS) {
        state.lastWheelDownTime = 0;
        clearScrollAsArrowsState();
      }
      state.lastWheelTime = now;
      if (item.name === "wheeldown") state.lastWheelDownTime = now;

      if (
        item.name === "wheelup" &&
        now - state.lastWheelDownTime < JEDITERM_PHANTOM_WHEELUP_MS &&
        isIntellijBlocksReworkedTerminal()
      ) {
        mutated ??= items.slice(0, i);
        mutated.push({ ...item, name: "wheeldown" });
        continue;
      }
      mutated?.push(item);
      continue;
    }

    if (
      (item.name === "up" || item.name === "down") &&
      !item.ctrl &&
      !item.meta &&
      !item.shift &&
      !item.isPasted &&
      now - state.lastWheelTime < JEDITERM_WHEEL_TO_ARROW_GAP_MS
    ) {
      if (!scrollBugSurfaced) {
        scrollBugSurfaced = true;
        onScrollBugDetected();
      }
      markScrollAsArrowsDetected();
      mutated ??= items.slice(0, i);

      continue;
    }
    mutated?.push(item);
  }
  return mutated ?? items;
}

type ArrowBurstWindowEntry = { t: number; n: number };
type ArrowBurstState = {
  arrowWindow: ArrowBurstWindowEntry[];
  arrowWindowDir: "up" | "down" | null;
};

function detectArrowBurst(app: App, items: InputEvent[]): void {
  const first = items[0];

  if (
    !first ||
    first.kind !== "key" ||
    (first.name !== "up" && first.name !== "down") ||
    first.ctrl ||
    first.meta ||
    first.shift ||
    first.isPasted ||
    !items.every((x) => x.kind === "key" && x.name === first.name && !x.ctrl && !x.meta && !x.shift)
  ) {
    app.arrowBurstState.arrowWindow.length = 0;
    return;
  }
  const dir = first.name as "up" | "down";
  if (app.arrowBurstState.arrowWindowDir !== dir) {
    app.arrowBurstState.arrowWindow.length = 0;
    app.arrowBurstState.arrowWindowDir = dir;
  }
  const now = performance.now();
  const w = app.arrowBurstState.arrowWindow;
  w.push({ t: now, n: items.length });
  while (w.length > 0 && now - w[0]!.t > ARROW_BURST_WINDOW_MS) w.shift();
  let total = 0;
  for (const entry of w) total += entry.n;
  if (total >= ARROW_BURST_THRESHOLD) {
    app.internal_eventEmitter.emit("arrow-burst", {
      direction: dir,
      count: total,
    });
    app.props.onStdinResume?.();
    w.length = 0;
  }
}

type State = {
  readonly error?: Error | undefined;
};

export default class App extends PureComponent<Props, State> {
  static displayName = "InternalApp";

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override state = {
    error: undefined,
  };

  rawModeEnabledCount = 0;

  internal_eventEmitter = new EventEmitter();
  keyParseState = INITIAL_PARSER_STATE;

  incompleteEscapeTimer: NodeJS.Timeout | null = null;
  pasteTimeoutTimer: NodeJS.Timeout | null = null;
  incompleteEscapeRearmCount = 0;
  pasteTimeoutRearmCount = 0;

  readonly ESCAPE_SEQUENCE_TIMEOUT_MS = 50;
  readonly PASTE_DETECTION_TIMEOUT_MS = 500;

  querier = this.props.terminalProbe ?? new TerminalProbe(this.props.stdout);

  lastStdinTime = Date.now();

  jediTermInput: JediTermInput = createJediTermInput();

  arrowBurstState: ArrowBurstState = {
    arrowWindow: [],
    arrowWindowDir: null,
  };

  emitJediTermScrollBug = (): void => {
    this.internal_eventEmitter.emit("jediterm-scroll-bug");
  };

  isRawModeSupported(): boolean {
    return this.props.stdin.isTTY;
  }

  override render() {
    return (
      <TerminalSizeContext.Provider
        value={{
          columns: this.props.terminalColumns,
          rows: this.props.terminalRows,
        }}
      >
        <AppContext.Provider value={{ exit: this.onExitRequest }}>
          <StdinContext.Provider
            value={{
              stdin: this.props.stdin,
              setRawMode: this.handleSetRawMode,
              isRawModeSupported: this.isRawModeSupported(),

              internal_exitOnCtrlC: this.props.exitOnCtrlC,

              internal_eventEmitter: this.internal_eventEmitter,
              internal_querier: this.querier,
            }}
          >
            <ViewportActivityProvider>
              <TimekeeperProvider>
                <StaticFlushContext.Provider value={this.props.onStaticFlush ?? (() => {})}>
                  <PointerLocationContext.Provider
                    value={this.props.onCursorDeclaration ?? (() => {})}
                  >
                    {this.state.error ? (
                      <ErrorPresentation error={this.state.error as Error} />
                    ) : (
                      this.props.children
                    )}
                  </PointerLocationContext.Provider>
                </StaticFlushContext.Provider>
              </TimekeeperProvider>
            </ViewportActivityProvider>
          </StdinContext.Provider>
        </AppContext.Provider>
      </TerminalSizeContext.Provider>
    );
  }

  override componentDidMount() {
    if (this.props.stdout.isTTY && !isEnvTruthy(process.env.OTHERSIDE_ACCESSIBILITY)) {
      this.props.stdout.write(CURSOR_DISPLAY_OFF);
    }
  }

  override componentWillUnmount() {
    if (this.props.stdout.isTTY) {
      this.props.stdout.write(CURSOR_DISPLAY_ON);
    }

    if (this.incompleteEscapeTimer) {
      clearTimeout(this.incompleteEscapeTimer);
      this.incompleteEscapeTimer = null;
    }
    if (this.pasteTimeoutTimer) {
      clearTimeout(this.pasteTimeoutTimer);
      this.pasteTimeoutTimer = null;
    }
    if (this.isRawModeSupported()) {
      this.handleSetRawMode(false);
    }
  }

  override componentDidCatch(error: Error) {
    this.onExitRequest(error);
  }

  handleSetRawMode = (isEnabled: boolean): void => {
    const { stdin } = this.props;

    if (!this.isRawModeSupported()) {
      if (stdin === process.stdin) {
        throw new Error(
          "Raw mode is not supported on the current process.stdin, which Ink uses as input stream by default.\nRead about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported",
        );
      } else {
        throw new Error(
          "Raw mode is not supported on the stdin provided to Ink.\nRead about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported",
        );
      }
    }

    stdin.setEncoding("utf8");

    if (isEnabled) {
      if (this.rawModeEnabledCount === 0) {
        deactivateInputLatch();
        stdin.ref();
        stdin.setRawMode(true);
        stdin.addListener("readable", this.onInputReady);

        this.props.stdout.write(EBP);

        this.props.stdout.write(EFE);

        this.props.stdout.write(ENABLE_THEME_NOTIFY);

        if (supportsAdvancedInput()) {
          this.props.stdout.write(ENABLE_KITTY_KEYBOARD);
          this.props.stdout.write(ENABLE_MODIFY_OTHER_KEYS);
        }

        setImmediate(async () => {
          try {
            const [r] = await Promise.all([this.querier.send(xtversion()), this.querier.flush()]);
            if (r) {
              let name = r.name;

              if (process.env.TMUX && name.startsWith("tmux ")) {
                const { stdout } = await runProcessSafely(
                  "tmux",
                  ["display-message", "-p", "#{client_termtype}"],
                  { timeout: 1000, useCwd: false },
                );
                const trimmed = stdout.trim();
                if (trimmed) name = trimmed;
              }
              setDetectedTerminalVersion(name);
              emitDiagnosticOutput(`XTVERSION: terminal identified as "${name}"`);
            } else {
              emitDiagnosticOutput("XTVERSION: no reply (terminal ignored query)");
            }
          } catch (e) {
            emitDiagnosticOutput(`XTVERSION: probe failed: ${e}`);
          }
        });
      }

      this.rawModeEnabledCount++;
      return;
    }

    if (--this.rawModeEnabledCount === 0) {
      this.props.stdout.write(DISABLE_MODIFY_OTHER_KEYS);
      this.props.stdout.write(DISABLE_KITTY_KEYBOARD);

      this.props.stdout.write(DFE);

      this.props.stdout.write(DISABLE_THEME_NOTIFY);

      this.props.stdout.write(DBP);
      stdin.setRawMode(false);
      stdin.removeListener("readable", this.onInputReady);
      stdin.unref();
    }
  };

  resolveIncompleteSequence = (): void => {
    this.incompleteEscapeTimer = null;

    if (!this.keyParseState.incomplete) return;

    if (this.props.stdin.readableLength > 0) {
      let readSomething = false;
      try {
        let chunk;
        while ((chunk = this.props.stdin.read() as string | null) !== null) {
          readSomething = true;
          this.consumeInputBuffer(chunk);
        }
      } catch (error) {
        writeDebugError(error);
      }

      if (readSomething) {
        this.incompleteEscapeRearmCount = 0;
        return;
      }

      if (this.incompleteEscapeRearmCount < 3) {
        this.incompleteEscapeRearmCount++;
        const isPastePrefix =
          this.keyParseState.incomplete.length >= 3 &&
          (PASTE_START.startsWith(this.keyParseState.incomplete) ||
            PASTE_END.startsWith(this.keyParseState.incomplete));
        this.incompleteEscapeTimer = setTimeout(
          this.resolveIncompleteSequence,
          this.keyParseState.mode === "IN_PASTE" || isPastePrefix
            ? this.PASTE_DETECTION_TIMEOUT_MS
            : this.ESCAPE_SEQUENCE_TIMEOUT_MS,
        );
        return;
      }
    }

    this.incompleteEscapeRearmCount = 0;
    this.consumeInputBuffer(null);
  };

  resolvePasteTimeout = (): void => {
    this.pasteTimeoutTimer = null;

    if (this.props.stdin.readableLength > 0) {
      let readSomething = false;
      try {
        let chunk;
        while ((chunk = this.props.stdin.read() as string | null) !== null) {
          readSomething = true;
          this.consumeInputBuffer(chunk);
        }
      } catch (error) {
        writeDebugError(error);
      }

      if (readSomething) {
        this.pasteTimeoutRearmCount = 0;
        return;
      }

      if (this.pasteTimeoutRearmCount < 3) {
        this.pasteTimeoutRearmCount++;
        this.pasteTimeoutTimer = setTimeout(
          this.resolvePasteTimeout,
          this.PASTE_DETECTION_TIMEOUT_MS,
        );
        return;
      }
    }

    this.pasteTimeoutRearmCount = 0;
    this.consumeInputBuffer(null);
  };

  consumeInputBuffer = (input: string | Buffer | null): void => {
    if (input !== null) {
      this.incompleteEscapeRearmCount = 0;
      this.pasteTimeoutRearmCount = 0;
    }
    const [keys, newState] = parseInputSequence(this.keyParseState, input);
    this.keyParseState = newState;

    if (keys.length > 0) {
      reconciler.discreteUpdates(dispatchInputBatch, this, keys, undefined, undefined);
    }

    if (this.keyParseState.incomplete) {
      if (this.incompleteEscapeTimer) {
        clearTimeout(this.incompleteEscapeTimer);
      }
      const isPastePrefix =
        this.keyParseState.incomplete.length >= 3 &&
        (PASTE_START.startsWith(this.keyParseState.incomplete) ||
          PASTE_END.startsWith(this.keyParseState.incomplete));
      this.incompleteEscapeTimer = setTimeout(
        this.resolveIncompleteSequence,
        this.keyParseState.mode === "IN_PASTE" || isPastePrefix
          ? this.PASTE_DETECTION_TIMEOUT_MS
          : this.ESCAPE_SEQUENCE_TIMEOUT_MS,
      );
    } else {
      if (this.incompleteEscapeTimer) {
        clearTimeout(this.incompleteEscapeTimer);
        this.incompleteEscapeTimer = null;
      }
    }

    if (this.keyParseState.mode === "IN_PASTE") {
      if (this.pasteTimeoutTimer) {
        clearTimeout(this.pasteTimeoutTimer);
      }
      this.pasteTimeoutTimer = setTimeout(
        this.resolvePasteTimeout,
        this.PASTE_DETECTION_TIMEOUT_MS,
      );
    } else {
      if (this.pasteTimeoutTimer) {
        clearTimeout(this.pasteTimeoutTimer);
        this.pasteTimeoutTimer = null;
      }
    }
  };

  onInputReady = (): void => {
    const now = Date.now();
    if (now - this.lastStdinTime > STDIN_IDLE_THRESHOLD_MS) {
      this.props.onStdinResume?.();
    }
    this.lastStdinTime = now;
    try {
      let chunk;
      while ((chunk = this.props.stdin.read() as string | null) !== null) {
        this.consumeInputBuffer(chunk);
      }
    } catch (error) {
      writeDebugError(error);

      const { stdin } = this.props;
      if (
        this.rawModeEnabledCount > 0 &&
        !stdin.listeners("readable").includes(this.onInputReady)
      ) {
        emitDiagnosticOutput(
          "handleReadable: re-attaching stdin readable listener after error recovery",
          { level: "warn" },
        );
        stdin.addListener("readable", this.onInputReady);
      }
    }
  };

  onRawInput = (input: string | undefined): void => {
    if (input === "\x03" && this.props.exitOnCtrlC) {
      this.onExitRequest();
    }
  };

  onExitRequest = (error?: Error): void => {
    if (this.isRawModeSupported()) {
      this.handleSetRawMode(false);
    }

    this.props.onExit(error);
  };

  onTerminalFocusChange = (isFocused: boolean): void => {
    setPaneFocused(isFocused);
  };

  onProcessSuspend = (): void => {
    if (!this.isRawModeSupported()) {
      return;
    }

    const rawModeCountBeforeSuspend = this.rawModeEnabledCount;
    this.props.onStdinSuspend?.();

    while (this.rawModeEnabledCount > 0) {
      this.handleSetRawMode(false);
    }

    if (this.props.stdout.isTTY) {
      this.props.stdout.write(CURSOR_DISPLAY_ON + DFE + MOUSE_CAPTURE_OFF);
    }

    this.internal_eventEmitter.emit("suspend");

    const resumeHandler = () => {
      for (let i = 0; i < rawModeCountBeforeSuspend; i++) {
        if (this.isRawModeSupported()) {
          this.handleSetRawMode(true);
        }
      }

      if (this.props.stdout.isTTY) {
        if (!isEnvTruthy(process.env.OTHERSIDE_ACCESSIBILITY)) {
          this.props.stdout.write(CURSOR_DISPLAY_OFF);
        }

        this.props.stdout.write(EFE);
      }

      this.internal_eventEmitter.emit("resume");
      this.props.onTerminalResume?.();

      process.removeListener("SIGCONT", resumeHandler);
    };

    process.on("SIGCONT", resumeHandler);
    process.kill(process.pid, "SIGSTOP");
  };
}

function dispatchInputBatch(
  app: App,
  items: InputEvent[],
  _unused1: undefined,
  _unused2: undefined,
): void {
  if (items.some((item) => item.kind === "key")) {
    recordEventTimestamp();
  }

  items = applyJediTermScrollFix(
    app.jediTermInput,
    items,
    performance.now(),
    app.emitJediTermScrollBug,
  );

  detectArrowBurst(app, items);

  for (const item of items) {
    if (item.kind === "response") {
      if (item.response.type === "themeNotify") {
        notifyTerminalThemeNotify();
        continue;
      }
      app.querier.onResponse(item.response);
      continue;
    }

    if (item.kind === "mouse") {
      continue;
    }

    const sequence = item.sequence;

    if (sequence === FOCUS_IN) {
      app.onTerminalFocusChange(true);
      const event = new WindowActivityStateEvent("terminalfocus");
      app.internal_eventEmitter.emit("terminalfocus", event);
      continue;
    }
    if (sequence === FOCUS_OUT) {
      app.onTerminalFocusChange(false);

      const event = new WindowActivityStateEvent("terminalblur");
      app.internal_eventEmitter.emit("terminalblur", event);
      continue;
    }

    if (!getPaneFocused()) {
      setPaneFocused(true);
    }

    if (item.name === "z" && item.ctrl && SUPPORTS_SUSPEND) {
      app.onProcessSuspend();
      continue;
    }

    app.onRawInput(sequence);
    const event = new KeyStroke(item);
    app.internal_eventEmitter.emit("input", event);
  }
}
