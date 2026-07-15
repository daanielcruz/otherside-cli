import { createScreen, type StylePool } from "@/terminal-runtime/paint/cell-grid.js";
import type { Frame } from "@/terminal-runtime/paint/frame-state.js";
import Output from "@/terminal-runtime/paint/line-composer.js";
import renderNodeToBuffer, { resetDisplayLayout } from "@/terminal-runtime/paint/tree-projector.js";
import type { TreeElement } from "@/terminal-runtime/tree/elements.js";
import { drainAbsoluteRemovalState } from "@/terminal-runtime/tree/layout-cache.js";
import { emitDiagnosticOutput } from "@/utils/debug.js";

export type RenderOptions = {
  frontFrame: Frame;
  backFrame: Frame;
  isTTY: boolean;
  terminalWidth: number;
  terminalRows: number;
  prevFrameContaminated: boolean;
};

export type ScreenRenderFunction = (options: RenderOptions) => Frame;

export default function buildScreenRenderer(
  node: TreeElement,
  stylePool: StylePool,
): ScreenRenderFunction {
  let output: Output | undefined;
  return (options) => {
    const { frontFrame, backFrame, isTTY, terminalWidth, terminalRows } = options;
    const prevScreen = frontFrame.screen;
    const backScreen = backFrame.screen;
    const charPool = backScreen.charPool;
    const hyperlinkPool = backScreen.hyperlinkPool;

    const computedHeight = node.yogaNode?.getComputedHeight();
    const computedWidth = node.yogaNode?.getComputedWidth();
    const hasInvalidHeight =
      computedHeight === undefined || !Number.isFinite(computedHeight) || computedHeight < 0;
    const hasInvalidWidth =
      computedWidth === undefined || !Number.isFinite(computedWidth) || computedWidth < 0;

    if (!node.yogaNode || hasInvalidHeight || hasInvalidWidth) {
      if (node.yogaNode && (hasInvalidHeight || hasInvalidWidth)) {
        emitDiagnosticOutput(
          `Invalid yoga dimensions: width=${computedWidth}, height=${computedHeight}, ` +
            `childNodes=${node.childNodes.length}, terminalWidth=${terminalWidth}, terminalRows=${terminalRows}`,
        );
      }
      return {
        screen: createScreen(terminalWidth, 0, stylePool, charPool, hyperlinkPool),
        viewport: { width: terminalWidth, height: terminalRows },
        cursor: { x: 0, y: 0, visible: true },
      };
    }

    const width = Math.floor(node.yogaNode.getComputedWidth());
    const height = Math.floor(node.yogaNode.getComputedHeight());
    const screen = backScreen ?? createScreen(width, height, stylePool, charPool, hyperlinkPool);
    if (output) {
      output.reset(width, height, screen);
    } else {
      output = new Output({ width, height, stylePool, screen });
    }

    resetDisplayLayout();

    const absoluteRemoved = drainAbsoluteRemovalState();
    renderNodeToBuffer(node, output, {
      prevScreen: absoluteRemoved || options.prevFrameContaminated ? undefined : prevScreen,
    });

    const renderedScreen = output.get();

    return {
      screen: renderedScreen,
      viewport: {
        width: terminalWidth,
        height: terminalRows,
      },
      cursor: {
        x: 0,
        y: screen.height,
        visible: !isTTY || screen.height === 0,
      },
    };
  };
}
