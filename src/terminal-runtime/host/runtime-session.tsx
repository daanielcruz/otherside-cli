import { closeSync, constants as fsConstants, openSync, readSync, writeSync } from "node:fs";
import { format } from "node:util";
import autoBind from "auto-bind";
import noop from "lodash-es/noop.js";
import throttle from "lodash-es/throttle.js";
import { type ReactNode } from "react";
import type { FiberRoot } from "react-reconciler";
import { ConcurrentRoot, LegacyRoot } from "react-reconciler/constants.js";
import { onExit } from "signal-exit";
import { flushEventTimestamp } from "@/bootstrap/state.js";
import { bumpRender, bumpRendererMs } from "@/devtools/render/counters.ts";
import { getLayoutCounters } from "@/native-ts/yoga-layout/index.js";
import {
  ExternalClearWatcher,
  shouldWatchExternalClears,
} from "@/terminal-runtime/host/external-clear-watcher.js";
import instances from "@/terminal-runtime/host/runtime-registry.js";
import { RENDER_CYCLE_INTERVAL_MS } from "@/terminal-runtime/host/timing.js";
import {
  CharPool,
  createScreen,
  HyperlinkPool,
  migrateScreenPools,
  StylePool,
} from "@/terminal-runtime/paint/cell-grid.js";
import buildScreenRenderer, {
  type ScreenRenderFunction,
} from "@/terminal-runtime/paint/frame-renderer.js";
import { emptyFrame, type Frame, type FrameMetrics } from "@/terminal-runtime/paint/frame-state.js";
import Output from "@/terminal-runtime/paint/line-composer.js";
import {
  serializeFrameLines,
  TerminalRenderBuffer,
} from "@/terminal-runtime/paint/output-journal.js";
import renderNodeToBuffer, {
  hasLayoutChanged,
  resetDisplayLayout,
} from "@/terminal-runtime/paint/tree-projector.js";
import { InternalAccessibilityContext } from "@/terminal-runtime/react/accessibility-state.js";
import type {
  PointerLocation,
  PointerLocationUpdater,
} from "@/terminal-runtime/react/cursor-contract.js";
import { TerminalSizeContext } from "@/terminal-runtime/react/dimensions-context.js";
import App from "@/terminal-runtime/react/runtime-root.js";
import StaticFlushContext from "@/terminal-runtime/react/scrollback-context.js";
import { TerminalOutputProvider } from "@/terminal-runtime/react/use-terminal-alert.js";
import { TerminalProbe } from "@/terminal-runtime/terminal/capability-probe.js";
import {
  cursorMove,
  cursorTo,
  DISABLE_KITTY_KEYBOARD,
  ENABLE_KITTY_KEYBOARD,
  ENABLE_MODIFY_OTHER_KEYS,
  eraseLines,
} from "@/terminal-runtime/terminal/control-sequences.js";
import { MOUSE_CAPTURE_OFF } from "@/terminal-runtime/terminal/private-modes.js";
import {
  flushDiffBuffer,
  isWebTerminalEngine,
  SYNC_OUTPUT_CAPABLE,
  supportsAdvancedInput,
  type Terminal,
} from "@/terminal-runtime/terminal/runtime-channel.js";
import { wrapAnsi } from "@/terminal-runtime/text/ansi-wrap.js";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import * as dom from "@/terminal-runtime/tree/elements.js";
import { elementDimensionStore } from "@/terminal-runtime/tree/layout-cache.js";
import reconciler, {
  getLastLayoutComputeTime,
  getLastReconcileTime,
  isPerformanceDebugActive,
  recordLayoutComputeTime,
  resetPerformanceMetrics,
} from "@/terminal-runtime/tree/react-adapter.js";
import { optimize } from "@/terminal-runtime/tree/render-pruning.js";
import { emitDiagnosticOutput } from "@/utils/debug.js";
import { isEnvTruthy } from "@/utils/envUtils.js";
import { restoreTerminalModes } from "@/utils/gracefulShutdown.js";
import { writeDebugError } from "@/utils/log.js";
import {
  getAtlasMetrics,
  isAtlasResetEnabled,
  RECOVERABLE_TTY_ERRNOS,
  recordAtlasReset,
  resetAtlasKeys,
  setOverflow,
} from "@/utils/xtermAtlasMetrics.js";

export type Options = {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  stderr: NodeJS.WriteStream;
  exitOnCtrlC: boolean;
  patchConsole: boolean;
  waitUntilExit?: () => Promise<void>;
  onFrame?: ((event: FrameMetrics) => void) | undefined;
  nativeCursor?: boolean | undefined;
  isScreenReaderEnabled?: boolean | undefined;
};

export default class Ink {
  private readonly log: TerminalRenderBuffer;
  private readonly terminal: Terminal;
  private readonly terminalProbe: TerminalProbe;
  private externalClearWatcher: ExternalClearWatcher | null = null;
  private scheduleRender: (() => void) & { cancel?: () => void };

  private isUnmounted = false;
  private readonly container: FiberRoot;
  private rootNode: dom.TreeElement;
  private renderer: ScreenRenderFunction;
  private readonly stylePool: StylePool;
  private charPool: CharPool;
  private hyperlinkPool: HyperlinkPool;
  private exitPromise?: Promise<void>;
  private restoreConsole?: () => void;
  private restoreStderr?: () => void;
  private unsubscribeTTYHandlers?: () => void;
  private terminalColumns: number;
  private terminalRows: number;
  private currentNode: ReactNode = null;
  private frontFrame: Frame;
  private backFrame: Frame;
  private lastPoolResetTime = performance.now();
  private lastYogaCounters: {
    ms: number;
    visited: number;
    measured: number;
    cacheHits: number;
    live: number;
  } = { ms: 0, visited: 0, measured: 0, cacheHits: 0, live: 0 };

  private readonly staticFlushQueue: ReactNode[] = [];

  private prevFrameContaminated = false;

  private cursorDeclaration: PointerLocation | null = null;

  private displayCursor: { x: number; y: number } | null = null;

  private readonly accessibilityMode: boolean;

  private nativeCursorVisible: boolean;

  private readonly liveCountsEnabled: boolean;
  private isScreenReaderEnabled = false;
  private lastLiveCountSampleAt = 0;

  private hasRendered = false;

  private isExiting = false;

  private lastAtlasResetAt = 0;

  private lastStyleLiveSize = 0;

  private renderCalled = false;

  private prevScreenReaderLines: string[] = [];
  private prevScreenReaderPark = { row: 0, col: 0 };

  constructor(private readonly options: Options) {
    autoBind(this);

    this.accessibilityMode = isEnvTruthy(process.env.OTHERSIDE_ACCESSIBILITY);
    this.nativeCursorVisible = this.accessibilityMode;
    this.liveCountsEnabled = isEnvTruthy(process.env.OTHERSIDE_BENCH_LIVE_COUNTS);

    if (this.options.patchConsole) {
      this.restoreConsole = this.patchConsole();
      this.restoreStderr = this.patchStderr();
    }

    this.terminal = {
      stdout: options.stdout,
      stderr: options.stderr,
    };
    this.terminalProbe = new TerminalProbe(options.stdout);

    if (options.stdout === process.stdout) {
      if (options.stdout.isTTY) {
        options.stdout.write("\x1B7\x1b[r\x1B8\x1b[?25h");
      }
    }

    this.terminalColumns = options.stdout.columns || 80;
    this.terminalRows = options.stdout.rows || 24;
    this.stylePool = new StylePool();

    setOverflow(this.stylePool);
    this.charPool = new CharPool();
    this.hyperlinkPool = new HyperlinkPool();
    this.frontFrame = emptyFrame(
      this.terminalRows,
      this.terminalColumns,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    );
    this.backFrame = emptyFrame(
      this.terminalRows,
      this.terminalColumns,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    );

    this.log = new TerminalRenderBuffer({
      isTTY: (options.stdout.isTTY as boolean | undefined) || false,
      stylePool: this.stylePool,
    });

    const deferredRender = (): void => queueMicrotask(this.onRender);
    this.scheduleRender = throttle(deferredRender, RENDER_CYCLE_INTERVAL_MS, {
      leading: true,
      trailing: true,
    });

    this.isUnmounted = false;

    this.unsubscribeExit = onExit(this.unmount, { alwaysLast: false });

    this.rootNode = dom.createTreeElement("ink-root");
    this.renderer = buildScreenRenderer(this.rootNode, this.stylePool);
    this.rootNode.onRender = this.scheduleRender;
    this.rootNode.onImmediateRender = this.onRender;
    this.rootNode.onComputeLayout = () => {
      if (this.isUnmounted) {
        return;
      }

      if (this.options.stdout.isTTY && this.syncTerminalSize()) {
        const node = this.currentNode;
        if (node !== null) {
          queueMicrotask(() => {
            if (!this.isUnmounted) {
              this.render(node);
            }
          });
        }
      }

      if (this.rootNode.yogaNode) {
        const t0 = performance.now();
        const node = this.rootNode.yogaNode;

        if (this.options.stdout.isTTY || this.options.stdout.columns) {
          node.setWidth(this.terminalColumns);
          node.calculateLayout(this.terminalColumns);
        } else {
          node.setWidthAuto();
          node.calculateLayout();
          if (node.getComputedWidth() > 8192) {
            node.setWidth(8192);
            node.calculateLayout(8192);
          }
        }
        const ms = performance.now() - t0;
        recordLayoutComputeTime(ms);
        const c = getLayoutCounters();
        this.lastYogaCounters = { ms, ...c };
      }
    };

    this.container = reconciler.createContainer(
      this.rootNode,
      ConcurrentRoot,
      null,
      false,
      null,
      "id",
      noop,
      noop,
      noop,
      noop,
    );
  }

  private forceRedraw(): void {
    this.frontFrame = emptyFrame(
      this.frontFrame.viewport.height,
      this.frontFrame.viewport.width,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    );
    this.backFrame = emptyFrame(
      this.backFrame.viewport.height,
      this.backFrame.viewport.width,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    );
    this.log.reset();
    this.prevFrameContaminated = true;

    this.displayCursor = null;
    this.nativeCursorVisible = this.accessibilityMode;
    this.resetScreenReaderDiffState();

    if (this.currentNode !== null) {
      this.render(this.currentNode);
      this.scheduleRender();
    }
  }

  private getExternalClearExpectedCursorRow = (): number | null => {
    const parked = this.displayCursor;
    // displayCursor is the final zero-based physical cursor park position after the frame write.
    return parked === null ? null : parked.y + 1;
  };

  private startExternalClearWatcher(): void {
    if (
      !shouldWatchExternalClears({
        stdoutIsTTY: this.options.stdout.isTTY,
        termProgram: process.env.TERM_PROGRAM,
        disabled: process.env.OTHERSIDE_DISABLE_EXTERNAL_CLEAR_WATCHER,
      }) ||
      this.isScreenReaderEnabled
    ) {
      return;
    }
    this.externalClearWatcher ??= new ExternalClearWatcher({
      querier: this.terminalProbe,
      getExpectedCursorRow: this.getExternalClearExpectedCursorRow,
      onScreenClear: this.forceRedraw,
    });
    this.externalClearWatcher.start();
  }

  private stopExternalClearWatcher = (): void => {
    this.externalClearWatcher?.stop();
  };

  private handleResume = () => {
    if (!this.options.stdout.isTTY) {
      return;
    }

    this.forceRedraw();
    this.startExternalClearWatcher();
  };

  private hasStaleTerminalSize(): boolean {
    return (
      (this.options.stdout.columns || 80) !== this.terminalColumns ||
      (this.options.stdout.rows || 24) !== this.terminalRows
    );
  }

  private syncTerminalSize(): boolean {
    const cols = this.options.stdout.columns || 80;
    const rows = this.options.stdout.rows || 24;
    if (cols === this.terminalColumns && rows === this.terminalRows) {
      return false;
    }
    this.terminalColumns = cols;
    this.terminalRows = rows;
    this.resetScreenReaderDiffState();
    return true;
  }

  private handleResize = () => {
    if (!this.syncTerminalSize()) return;

    this.prevFrameContaminated = true;

    dom.invalidateTreeLayout(this.rootNode);

    if (this.currentNode !== null) {
      this.render(this.currentNode);
    }
  };

  resolveExitPromise: () => void = () => {};
  rejectExitPromise: (reason?: Error) => void = () => {};
  unsubscribeExit: () => void = () => {};

  private ensureInteractive = (): void => {
    if (this.unsubscribeTTYHandlers || !this.options.stdout.isTTY) {
      return;
    }
    if (!this.accessibilityMode && !this.isScreenReaderEnabled) {
      this.options.stdout.write("\x1b[?25l");
    }
    this.options.stdout.on("resize", this.handleResize);
    process.on("SIGCONT", this.handleResume);
    this.startExternalClearWatcher();
    this.unsubscribeTTYHandlers = () => {
      this.stopExternalClearWatcher();
      this.options.stdout.off("resize", this.handleResize);
      process.off("SIGCONT", this.handleResume);
    };
  };

  skipSyncMarkers(): boolean {
    if (!this.options.stdout.isTTY) return true;
    if (!SYNC_OUTPUT_CAPABLE) return true;
    if (!this.unsubscribeTTYHandlers) return true;
    return false;
  }

  resetScreenReaderDiffState(): void {
    this.prevScreenReaderLines = [];
    this.prevScreenReaderPark = { row: 0, col: 0 };
  }

  enqueueStaticFlush(node: ReactNode): void {
    if (this.isUnmounted) {
      return;
    }
    this.staticFlushQueue.push(node);
    this.scheduleRender();
  }

  private drainStaticFlushQueue(width: number): string[] {
    const output: string[] = [];
    while (this.staticFlushQueue.length > 0) {
      const nodes = this.staticFlushQueue.splice(0);
      for (const node of nodes) {
        output.push(this.renderStaticFlushNode(node, width));
      }
    }
    return output;
  }

  private flushStaticQueueBeforeFinalErase(): void {
    if (this.staticFlushQueue.length === 0) {
      return;
    }
    const staticFlushText = this.drainStaticFlushQueue(this.options.stdout.columns || 80);
    const diff = this.log.rebaseAfterStaticFlush(this.frontFrame);
    if (staticFlushText.length > 0) {
      diff.splice(
        1,
        0,
        ...staticFlushText.map((content) => ({ type: "stdout" as const, content })),
      );
    }
    flushDiffBuffer(
      this.terminal,
      optimize(diff),
      this.skipSyncMarkers(),
      this.options.stdout.rows || 24,
    );
  }

  private renderStaticFlushNode(node: ReactNode, width: number): string {
    const root = dom.createTreeElement("ink-root");

    const stylePool = new StylePool();
    const charPool = new CharPool();
    const hyperlinkPool = new HyperlinkPool();
    const container = reconciler.createContainer(
      root,
      LegacyRoot,
      null,
      false,
      null,
      "static-flush-render",
      noop,
      noop,
      noop,
      noop,
    );

    const tree = (
      <TerminalSizeContext.Provider value={{ columns: width, rows: this.terminalRows }}>
        <StaticFlushContext.Provider value={this.enqueueStaticFlush}>
          {node}
        </StaticFlushContext.Provider>
      </TerminalSizeContext.Provider>
    );

    reconciler.updateContainerSync(tree, container, null, noop);
    reconciler.flushSyncWork();

    root.yogaNode?.setWidth(width);
    root.yogaNode?.calculateLayout(width);
    const height = Math.max(0, Math.ceil(root.yogaNode?.getComputedHeight() ?? 0));
    const screen = createScreen(width, height, stylePool, charPool, hyperlinkPool);
    const output = new Output({ width, height, stylePool, screen });

    resetDisplayLayout();
    renderNodeToBuffer(root, output, { prevScreen: undefined });
    const frame: Frame = {
      screen: output.get(),
      viewport: { width, height: this.terminalRows },
      cursor: { x: 0, y: height, visible: true },
    };

    reconciler.updateContainerSync(null, container, null, noop);
    reconciler.flushSyncWork();
    root.yogaNode?.free();
    root.yogaNode = undefined;

    return serializeFrameLines(frame, stylePool)
      .map((line) => `${line}\n`)
      .join("");
  }

  onRender() {
    if (this.isUnmounted) {
      return;
    }

    if (this.hasRendered && !this.isExiting) {
      this.ensureInteractive();
    }
    this.hasRendered = true;
    bumpRender();

    flushEventTimestamp();

    const renderStart = performance.now();
    const terminalWidth = this.options.stdout.columns || 80;
    const terminalRows = this.options.stdout.rows || 24;

    const frame = this.renderer({
      frontFrame: this.frontFrame,
      backFrame: this.backFrame,
      isTTY: this.options.stdout.isTTY,
      terminalWidth,
      terminalRows,
      prevFrameContaminated: this.prevFrameContaminated,
    });
    const rendererMs = performance.now() - renderStart;
    bumpRendererMs(rendererMs);

    if (hasLayoutChanged() || this.prevFrameContaminated) {
      frame.screen.damage = {
        x: 0,
        y: 0,
        width: frame.screen.width,
        height: frame.screen.height,
      };
    }

    const prevFrame = this.frontFrame;

    const tDiff = performance.now();

    const staticFlushQueued = this.staticFlushQueue.length > 0;
    const staticFlushText = staticFlushQueued ? this.drainStaticFlushQueue(terminalWidth) : [];
    // Absolute row of the prompt caret in the next frame, when one is declared.
    // The renderer uses it to keep the prompt anchored on a trailing shrink
    // (footer/menu below it collapsing) instead of re-entering scrollback.
    const promptDecl = this.cursorDeclaration;
    const promptDeclRect =
      promptDecl !== null ? elementDimensionStore.get(promptDecl.node) : undefined;
    const promptRowY =
      promptDecl !== null && promptDeclRect !== undefined
        ? promptDeclRect.y + promptDecl.relativeY
        : undefined;
    const diff = staticFlushQueued
      ? this.log.rebaseAfterStaticFlush(frame)
      : this.log.render(prevFrame, frame, promptRowY);
    if (staticFlushQueued && staticFlushText.length > 0) {
      diff.splice(
        1,
        0,
        ...staticFlushText.map((content) => ({ type: "stdout" as const, content })),
      );
    }
    const diffMs = performance.now() - tDiff;

    this.backFrame = this.frontFrame;
    this.frontFrame = frame;

    this.maybeResetPools(renderStart);

    const flickers: FrameMetrics["flickers"] = [];
    for (const patch of diff) {
      if (patch.type === "clearTerminal") {
        flickers.push({
          desiredHeight: frame.screen.height,
          availableHeight: frame.viewport.height,
          reason: patch.reason,
        });
        if (isPerformanceDebugActive() && patch.debug) {
          const chain = dom.findElementAncestorsAtRow(this.rootNode, patch.debug.triggerY);
          emitDiagnosticOutput(
            `[REPAINT] full reset · ${patch.reason} · row ${patch.debug.triggerY}\n` +
              `  prev: "${patch.debug.prevLine}"\n` +
              `  next: "${patch.debug.nextLine}"\n` +
              `  culprit: ${chain.length ? chain.join(" < ") : "(no owner chain captured)"}`,
            { level: "warn" },
          );
        }
      }
    }

    const tOptimize = performance.now();
    const optimized = optimize(diff);
    const optimizeMs = performance.now() - tOptimize;
    const hasDiff = optimized.length > 0;

    const decl = this.cursorDeclaration;
    const rect = decl !== null ? elementDimensionStore.get(decl.node) : undefined;
    const target =
      decl !== null && rect !== undefined
        ? { x: rect.x + decl.relativeX, y: rect.y + decl.relativeY }
        : null;
    const parked = this.displayCursor;

    const targetMoved =
      target !== null && (parked === null || parked.x !== target.x || parked.y !== target.y);
    if (hasDiff || targetMoved || (target === null && parked !== null)) {
      if (parked !== null && hasDiff) {
        const pdx = prevFrame.cursor.x - parked.x;
        const pdy = prevFrame.cursor.y - parked.y;
        if (pdx !== 0 || pdy !== 0) {
          optimized.unshift({ type: "stdout", content: cursorMove(pdx, pdy) });
        }
      }

      if (target !== null) {
        const from =
          !hasDiff && parked !== null ? parked : { x: frame.cursor.x, y: frame.cursor.y };
        const dx = target.x - from.x;
        const dy = target.y - from.y;
        if (dx !== 0 || dy !== 0) {
          optimized.push({ type: "stdout", content: cursorMove(dx, dy) });
        }
        this.displayCursor = target;

        if (this.options.nativeCursor) {
          const shouldShow = decl?.visible || this.accessibilityMode;
          if (this.nativeCursorVisible) {
            optimized.unshift({ type: "cursorHide" });
          }
          if (shouldShow) {
            optimized.push({ type: "cursorShow" });
          }
          this.nativeCursorVisible = shouldShow;
        }
      } else {
        if (parked !== null && !hasDiff) {
          const rdx = frame.cursor.x - parked.x;
          const rdy = frame.cursor.y - parked.y;
          if (rdx !== 0 || rdy !== 0) {
            optimized.push({ type: "stdout", content: cursorMove(rdx, rdy) });
          }
        }
        this.displayCursor = null;
        if (this.options.nativeCursor && this.nativeCursorVisible && !this.accessibilityMode) {
          optimized.unshift({ type: "cursorHide" });
          this.nativeCursorVisible = false;
        }
      }
    }

    if (hasDiff) {
      this.maybeProactiveAtlasReset(optimized);
    }

    const tWrite = performance.now();
    flushDiffBuffer(this.terminal, optimized, this.skipSyncMarkers(), terminalRows);
    const writeMs = performance.now() - tWrite;

    this.prevFrameContaminated = false;

    const yogaMs = getLastLayoutComputeTime();
    const commitMs = getLastReconcileTime();
    const yc = this.lastYogaCounters;

    resetPerformanceMetrics();
    this.lastYogaCounters = {
      ms: 0,
      visited: 0,
      measured: 0,
      cacheHits: 0,
      live: 0,
    };
    this.options.onFrame?.({
      durationMs: performance.now() - renderStart,
      phases: {
        renderer: rendererMs,
        diff: diffMs,
        optimize: optimizeMs,
        write: writeMs,
        patches: diff.length,
        yoga: yogaMs,
        commit: commitMs,
        yogaVisited: yc.visited,
        yogaMeasured: yc.measured,
        yogaCacheHits: yc.cacheHits,
        yogaLive: yc.live,
        ...(this.liveCountsEnabled && this.shouldSampleLiveCounts()
          ? {
              domLive: countLiveDOMNodes(this.rootNode),
              fiberLive: countLiveFiberNodes(this.container.current),
            }
          : {}),
      },
      flickers,
    });

    if (this.isScreenReaderEnabled) {
      this.onRenderScreenReader();
    }
  }

  private shouldSampleLiveCounts(): boolean {
    const now = performance.now();
    if (now - this.lastLiveCountSampleAt < 100) {
      return false;
    }
    this.lastLiveCountSampleAt = now;
    return true;
  }

  private onRenderScreenReader(): void {
    const text = dom.renderAccessibilityText(this.rootNode);
    const cols = this.options.stdout.columns || 80;
    const lines = text === "" ? [] : text.split("\n");
    const lineOffsets: number[] = [];
    const wrappedLines: string[] = [];

    for (const rawLine of lines) {
      if (rawLine === "") {
        lineOffsets.push(wrappedLines.length);
        wrappedLines.push("");
      } else {
        lineOffsets.push(wrappedLines.length);

        const wrapped = wrapAnsi(rawLine, cols, {
          trim: false,
          hard: true,
        });
        for (const line of wrapped.split("\n")) {
          wrappedLines.push(line.trimEnd());
        }
      }
    }

    const prevLines = this.prevScreenReaderLines;
    const maxRow = Math.max(0, wrappedLines.length - 1);
    const park = this.computeScreenReaderPark(text, lineOffsets, wrappedLines, cols) ?? {
      row: maxRow,
      col: stringWidth(wrappedLines[maxRow] ?? ""),
    };

    let samePrefixCount = 0;
    const minLines = Math.min(prevLines.length, wrappedLines.length);
    while (
      samePrefixCount < minLines &&
      prevLines[samePrefixCount] === wrappedLines[samePrefixCount]
    ) {
      samePrefixCount++;
    }

    const allLinesMatch =
      samePrefixCount === prevLines.length && samePrefixCount === wrappedLines.length;
    const prevPark = this.prevScreenReaderPark;
    const parkMatches = park.row === prevPark.row && park.col === prevPark.col;

    if (allLinesMatch && parkMatches) {
      return;
    }

    const lastPrevIdx = Math.max(0, prevLines.length - 1);
    const parkReset = prevPark.row !== lastPrevIdx ? cursorMove(0, lastPrevIdx - prevPark.row) : "";
    const eraseSeq = eraseLines(prevLines.length - samePrefixCount);
    const contentToPrint = wrappedLines.slice(samePrefixCount).join("\n");

    let output = "";
    if (allLinesMatch) {
      output = "";
    } else if (samePrefixCount === prevLines.length) {
      output = samePrefixCount > 0 ? `\n${contentToPrint}` : contentToPrint;
    } else if (contentToPrint === "") {
      output = samePrefixCount > 0 ? eraseSeq + cursorMove(0, -1) : eraseSeq;
    } else {
      output = eraseSeq + contentToPrint;
    }

    const parkTargetSeq =
      cursorTo(park.col + 1) + (park.row !== maxRow ? cursorMove(0, park.row - maxRow) : "");

    this.options.stdout.write(parkReset + output + parkTargetSeq);
    this.prevScreenReaderLines = wrappedLines;
    this.prevScreenReaderPark = park;
  }

  private computeScreenReaderPark(
    text: string,
    lineOffsets: number[],
    wrappedLines: string[],
    cols: number,
  ): { row: number; col: number } | null {
    const decl = this.cursorDeclaration;
    if (decl === null) return null;
    const offset = dom.findAccessibilityNodeOffset(this.rootNode, decl.node);
    if (offset === null) return null;

    const beforeText = text.slice(0, offset);
    const relativeRow = beforeText.split("\n").length - 1 + decl.relativeY;
    if (relativeRow < 0 || relativeRow >= lineOffsets.length) return null;

    const lastNewlineIdx = beforeText.lastIndexOf("\n") + 1;
    const colOffset =
      (decl.relativeY === 0 ? stringWidth(beforeText.slice(lastNewlineIdx, offset)) : 0) +
      decl.relativeX;

    const wrappedLineIndex = cols > 0 ? Math.floor(colOffset / cols) : 0;
    const targetLineIdx = Math.min(
      lineOffsets[relativeRow]! + wrappedLineIndex,
      wrappedLines.length - 1,
    );
    const remainderCol = cols > 0 ? colOffset % cols : colOffset;

    return {
      row: Math.max(0, targetLineIdx),
      col: Math.max(0, remainderCol),
    };
  }

  private emitAtlasReset(patches?: any[]): void {
    const clearSeq = "\x1B]104;255\x07";
    if (patches) {
      patches.unshift({ type: "stdout", content: clearSeq });
    } else {
      this.options.stdout.write(clearSeq);
    }
    resetAtlasKeys();
    this.lastAtlasResetAt = performance.now();
  }

  private maybeProactiveAtlasReset(patches: any[]): void {
    if (!isAtlasResetEnabled()) return;
    if (getAtlasMetrics().atlasKeys < 2000) return;
    if (performance.now() - this.lastAtlasResetAt < 2000) return;
    if (!isWebTerminalEngine()) return;
    this.emitAtlasReset(patches);
    recordAtlasReset("delta");
  }

  invalidatePrevFrame(): void {
    this.prevFrameContaminated = true;
  }

  reassertTerminalModes = (): void => {
    if (!this.options.stdout.isTTY) return;

    if (supportsAdvancedInput()) {
      this.options.stdout.write(
        DISABLE_KITTY_KEYBOARD + ENABLE_KITTY_KEYBOARD + ENABLE_MODIFY_OTHER_KEYS,
      );
    }
  };

  drainStdin(): void {
    drainStdin(this.options.stdin);
  }

  private writeRaw(data: string): void {
    this.options.stdout.write(data);
  }

  private setCursorDeclaration: PointerLocationUpdater = (decl, clearIfNode) => {
    if (
      decl === null &&
      clearIfNode !== undefined &&
      this.cursorDeclaration?.node !== clearIfNode
    ) {
      return;
    }
    this.cursorDeclaration = decl;
  };

  render(node: ReactNode): void {
    this.renderCalled = true;
    this.currentNode = node;

    const AppComp: any = App;
    const tree = (
      <AppComp
        stdin={this.options.stdin}
        stdout={this.options.stdout}
        stderr={this.options.stderr}
        exitOnCtrlC={this.options.exitOnCtrlC}
        onExit={this.unmount}
        terminalColumns={this.terminalColumns}
        terminalRows={this.terminalRows}
        onStdinResume={this.reassertTerminalModes}
        onStdinSuspend={this.stopExternalClearWatcher}
        onTerminalResume={() => this.startExternalClearWatcher()}
        terminalProbe={this.terminalProbe}
        onCursorDeclaration={this.setCursorDeclaration}
        onStaticFlush={this.enqueueStaticFlush}
      >
        <InternalAccessibilityContext.Provider value={this.isScreenReaderEnabled}>
          <TerminalOutputProvider value={this.writeRaw}>{node}</TerminalOutputProvider>
        </InternalAccessibilityContext.Provider>
      </AppComp>
    );

    reconciler.updateContainerSync(tree, this.container, null, noop);

    reconciler.flushSyncWork();
  }

  unmount(error?: Error | number | null): void {
    if (this.isUnmounted) {
      return;
    }
    this.isExiting = true;
    this.stopExternalClearWatcher();

    this.onRender();
    this.flushStaticQueueBeforeFinalErase();
    this.unsubscribeExit();

    if (typeof this.restoreConsole === "function") {
      this.restoreConsole();
    }
    this.restoreStderr?.();

    this.unsubscribeTTYHandlers?.();

    if (this.renderCalled) {
      const diff = this.log.renderPreviousOutput_DEPRECATED(this.frontFrame);
      flushDiffBuffer(
        this.terminal,
        optimize(diff),
        this.skipSyncMarkers(),
        this.options.stdout.rows || 24,
      );
    }

    if (this.options.stdout.isTTY) {
      try {
        writeSync(1, MOUSE_CAPTURE_OFF);

        this.drainStdin();

        restoreTerminalModes();
      } catch (err: any) {
        if (err && typeof err === "object" && RECOVERABLE_TTY_ERRNOS.has(err.code)) {
          emitDiagnosticOutput(`unmount terminal cleanup writeSync failed: ${err}`, {
            level: "error",
          });
        } else {
          throw err;
        }
      }
    }

    this.isUnmounted = true;

    this.scheduleRender.cancel?.();
    reconciler.updateContainerSync(null, this.container, null, noop);

    reconciler.flushSyncWork();
    instances.delete(this.options.stdout);

    this.rootNode.yogaNode?.free();
    this.rootNode.yogaNode = undefined;

    if (error instanceof Error) {
      this.rejectExitPromise(error);
    } else {
      this.resolveExitPromise();
    }
  }

  async waitUntilExit(): Promise<void> {
    this.exitPromise ||= new Promise((resolve, reject) => {
      this.resolveExitPromise = resolve;
      this.rejectExitPromise = reject;
    });

    return this.exitPromise;
  }

  private maybeResetPools(now: number): void {
    const elapsed = now - this.lastPoolResetTime;
    if (elapsed <= 30000) return;
    if (elapsed <= 300000 && !this.stylePool.needsCompaction(this.lastStyleLiveSize)) {
      return;
    }
    this.lastPoolResetTime = now;
    this.resetPools();
  }

  resetPools(): void {
    const exceedsHyperlinkCap = this.hyperlinkPool.size > 4096;
    const stylePoolNeedsCompaction = this.stylePool.needsCompaction(this.lastStyleLiveSize);
    if (!exceedsHyperlinkCap && !stylePoolNeedsCompaction) return;

    if (exceedsHyperlinkCap) {
      this.hyperlinkPool = new HyperlinkPool();
    }
    migrateScreenPools(
      this.frontFrame.screen,
      this.charPool,
      this.hyperlinkPool,
      stylePoolNeedsCompaction ? this.stylePool.compact() : undefined,
    );
    if (stylePoolNeedsCompaction) {
      this.lastStyleLiveSize = this.stylePool.size;
    }

    this.backFrame.screen.hyperlinkPool = this.hyperlinkPool;
  }

  patchConsole(): () => void {
    const con = console;
    const originals: Partial<Record<keyof Console, Console[keyof Console]>> = {};
    const toDebug = (...args: unknown[]) => emitDiagnosticOutput(`console.log: ${format(...args)}`);
    const toError = (...args: unknown[]) =>
      writeDebugError(new Error(`console.error: ${format(...args)}`));
    for (const m of STDOUT_CONSOLE_METHODS) {
      originals[m] = con[m];
      con[m] = toDebug;
    }
    for (const m of STDERR_CONSOLE_METHODS) {
      originals[m] = con[m];
      con[m] = toError;
    }
    originals.assert = con.assert;
    con.assert = (condition: unknown, ...args: unknown[]) => {
      if (!condition) toError(...args);
    };
    return () => Object.assign(con, originals);
  }

  private patchStderr(): () => void {
    const stderr = process.stderr;
    const originalWrite = stderr.write;
    let reentered = false;
    const intercept = (
      chunk: Uint8Array | string,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean => {
      const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;

      if (reentered) {
        const encoding = typeof encodingOrCb === "string" ? encodingOrCb : undefined;
        return originalWrite.call(stderr, chunk, encoding, callback);
      }
      reentered = true;
      try {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        emitDiagnosticOutput(`[stderr] ${text}`, { level: "warn" });
      } finally {
        reentered = false;
        callback?.();
      }
      return true;
    };
    stderr.write = intercept;
    return () => {
      if (stderr.write === intercept) {
        stderr.write = originalWrite;
      }
    };
  }
}

export function drainStdin(stdin: NodeJS.ReadStream = process.stdin): void {
  if (!stdin.isTTY) return;

  try {
    while (stdin.read() !== null) {}
  } catch {}

  if (process.platform === "win32") return;

  const tty = stdin as NodeJS.ReadStream & {
    isRaw?: boolean;
    setRawMode?: (raw: boolean) => void;
  };
  const wasRaw = tty.isRaw === true;

  let fd = -1;
  try {
    if (!wasRaw) tty.setRawMode?.(true);
    fd = openSync("/dev/tty", fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const buf = Buffer.alloc(1024);
    for (let i = 0; i < 64; i++) {
      if (readSync(fd, buf, 0, buf.length, null) <= 0) break;
    }
  } catch {
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {}
    }
    if (!wasRaw) {
      try {
        tty.setRawMode?.(false);
      } catch {}
    }
  }
}

const STDOUT_CONSOLE_METHODS = [
  "log",
  "info",
  "debug",
  "dir",
  "dirxml",
  "count",
  "countReset",
  "group",
  "groupCollapsed",
  "groupEnd",
  "table",
  "time",
  "timeEnd",
  "timeLog",
] as const;
const STDERR_CONSOLE_METHODS = ["warn", "error", "trace"] as const;

function countLiveFiberNodes(fiber: any): number {
  if (!fiber) return 0;
  let count = 0;
  const stack: any[] = [fiber];
  while (stack.length > 0) {
    const node = stack.pop();
    count++;
    if (node.alternate) count++;
    if (node.sibling) stack.push(node.sibling);
    if (node.child) stack.push(node.child);
  }
  return count;
}

function countLiveDOMNodes(dom: any): number {
  if (!dom) return 0;
  let count = 0;
  const stack: any[] = [dom];
  while (stack.length > 0) {
    const node = stack.pop();
    count++;
    if ("childNodes" in node) {
      const children = node.childNodes;
      for (let i = 0; i < children.length; i++) {
        stack.push(children[i]);
      }
    }
  }
  return count;
}
