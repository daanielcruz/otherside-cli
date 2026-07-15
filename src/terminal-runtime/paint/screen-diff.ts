import noop from "lodash-es/noop.js";
import type { ReactElement } from "react";
import { LegacyRoot } from "react-reconciler/constants.js";
import {
  CharPool,
  createScreen,
  HyperlinkPool,
  type Screen,
  StylePool,
} from "@/terminal-runtime/paint/cell-grid.js";
import Output from "@/terminal-runtime/paint/line-composer.js";
import renderNodeToBuffer, { resetDisplayLayout } from "@/terminal-runtime/paint/tree-projector.js";
import { createTreeElement, type TreeElement } from "@/terminal-runtime/tree/elements.js";
import reconciler from "@/terminal-runtime/tree/react-adapter.js";
import { emitDiagnosticOutput } from "@/utils/debug.js";

let root: TreeElement | undefined;
let container: ReturnType<typeof reconciler.createContainer> | undefined;
let stylePool: StylePool | undefined;
let charPool: CharPool | undefined;
let hyperlinkPool: HyperlinkPool | undefined;
let output: Output | undefined;

const timing = { reconcile: 0, yoga: 0, paint: 0, calls: 0 };
const METRICS_SAMPLE_INTERVAL = 20;

export function paintToTerminal(
  el: ReactElement,
  width: number,
): { screen: Screen; height: number } {
  if (!root) {
    root = createTreeElement("ink-root");
    stylePool = new StylePool();
    charPool = new CharPool();
    hyperlinkPool = new HyperlinkPool();

    container = reconciler.createContainer(
      root,
      LegacyRoot,
      null,
      false,
      null,
      "search-render",
      noop,
      noop,
      noop,
      noop,
    );
  }

  const t0 = performance.now();

  reconciler.updateContainerSync(el, container, null, noop);

  reconciler.flushSyncWork();
  const t1 = performance.now();

  root.yogaNode?.setWidth(width);
  root.yogaNode?.calculateLayout(width);
  const height = Math.ceil(root.yogaNode?.getComputedHeight() ?? 0);
  const t2 = performance.now();

  const screen = createScreen(width, Math.max(1, height), stylePool!, charPool!, hyperlinkPool!);
  if (!output) {
    output = new Output({ width, height, stylePool: stylePool!, screen });
  } else {
    output.reset(width, height, screen);
  }
  resetDisplayLayout();
  renderNodeToBuffer(root, output, { prevScreen: undefined });

  const rendered = output.get();
  const t3 = performance.now();

  reconciler.updateContainerSync(null, container, null, noop);

  reconciler.flushSyncWork();

  timing.reconcile += t1 - t0;
  timing.yoga += t2 - t1;
  timing.paint += t3 - t2;
  if (++timing.calls % METRICS_SAMPLE_INTERVAL === 0) {
    const total = timing.reconcile + timing.yoga + timing.paint;
    emitDiagnosticOutput(
      `renderToScreen: ${timing.calls} calls · ` +
        `reconcile=${timing.reconcile.toFixed(1)}ms yoga=${timing.yoga.toFixed(1)}ms ` +
        `paint=${timing.paint.toFixed(1)}ms · ` +
        `total=${total.toFixed(1)}ms · avg ${(total / timing.calls).toFixed(2)}ms/call`,
    );
  }

  return { screen: rendered, height };
}
