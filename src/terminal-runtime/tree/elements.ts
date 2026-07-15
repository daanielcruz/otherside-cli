import indentString from "indent-string";
import { buildLayoutNode } from "@/terminal-runtime/geometry/compute-layout.js";
import type { LayoutElement } from "@/terminal-runtime/geometry/layout-element.js";
import {
  LayoutMeasurement,
  LayoutSide,
  LayoutVisibility,
} from "@/terminal-runtime/geometry/layout-element.js";
import renderBorder from "@/terminal-runtime/paint/border-strokes.js";
import type { DrawingOps, Screen } from "@/terminal-runtime/paint/cell-grid.js";
import type {
  Styles,
  TerminalColor,
  TerminalTextStyle,
} from "@/terminal-runtime/paint/style-model.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import wrapText, { elideWrapBoundarySpace } from "@/terminal-runtime/text/line-fold.js";
import { widestLine } from "@/terminal-runtime/text/max-line-width.js";
import { expandTabs } from "@/terminal-runtime/text/tab-expansion.js";
import calculateTextDimensions from "@/terminal-runtime/text/text-size.js";
import {
  deferredRegions,
  elementDimensionStore,
  queueRegionClear,
} from "@/terminal-runtime/tree/layout-cache.js";
import squashTextNodes, {
  type StyledSegment,
  squashTextNodesToSegments,
} from "@/terminal-runtime/tree/text-coalescing.js";

type RenderNodeBase = {
  parentNode: TreeElement | undefined;
  yogaNode?: LayoutElement | undefined;
  style: Styles;
};

export type TextNodeName = "#text";
export type ElementNodeNames =
  | "ink-root"
  | "ink-box"
  | "ink-text"
  | "ink-virtual-text"
  | "ink-link"
  | "ink-progress"
  | "ink-raw-ansi";

export type AnyNodeNames = ElementNodeNames | TextNodeName;

export type TreeElement = {
  nodeName: ElementNodeNames;
  attributes: Record<string, NodeAttributeValue>;
  childNodes: TreeNode[];
  textStyles?: TerminalTextStyle;
  accessibility?: any;

  onComputeLayout?: () => void;
  onRender?: () => void;
  onImmediateRender?: () => void;

  hasRenderedContent?: boolean;

  dirty: boolean;

  isHidden?: boolean;

  hasAbsoluteDescendant?: boolean;

  debugOwnerChain?: string[];
} & RenderNodeBase;

export type TreeTextNode = {
  nodeName: TextNodeName;
  nodeValue: string;
} & RenderNodeBase;

export type TreeNode<T = { nodeName: AnyNodeNames }> = T extends {
  nodeName: infer U;
}
  ? U extends "#text"
    ? TreeTextNode
    : TreeElement
  : never;

export type NodeAttributeValue = boolean | string | number;

export const createTreeElement = (nodeName: ElementNodeNames): TreeElement => {
  const needsYogaNode =
    nodeName !== "ink-virtual-text" && nodeName !== "ink-link" && nodeName !== "ink-progress";
  const node: TreeElement = {
    nodeName,
    style: {},
    attributes: {},
    childNodes: [],
    parentNode: undefined,
    yogaNode: needsYogaNode ? buildLayoutNode() : undefined,
    dirty: false,
  };

  if (nodeName === "ink-text") {
    node.yogaNode?.setMeasureFunc(computeTextDimensions.bind(null, node));
  } else if (nodeName === "ink-raw-ansi") {
    node.yogaNode?.setMeasureFunc(computeRawAnsiDimensions.bind(null, node));
  }

  return node;
};

export const appendChild = (node: TreeElement, childNode: TreeElement): void => {
  if (childNode.parentNode) {
    removeChild(childNode.parentNode, childNode);
  }

  childNode.parentNode = node;
  node.childNodes.push(childNode);

  if (childNode.yogaNode) {
    node.yogaNode?.insertChild(childNode.yogaNode, node.yogaNode.getChildCount());
  }

  if (childNode.style.position === "absolute" || childNode.hasAbsoluteDescendant) {
    markAbsoluteDescendant(node);
  }

  invalidateLayout(node);
};

export const insertChildBefore = (
  node: TreeElement,
  newChildNode: TreeNode,
  beforeChildNode: TreeNode,
): void => {
  if (newChildNode.parentNode) {
    removeChild(newChildNode.parentNode, newChildNode);
  }

  newChildNode.parentNode = node;

  if (
    newChildNode.style.position === "absolute" ||
    (newChildNode.nodeName !== "#text" && (newChildNode as TreeElement).hasAbsoluteDescendant)
  ) {
    markAbsoluteDescendant(node);
  }

  const index = node.childNodes.indexOf(beforeChildNode);

  if (index >= 0) {
    let yogaIndex = 0;
    if (newChildNode.yogaNode && node.yogaNode) {
      for (let i = 0; i < index; i++) {
        if (node.childNodes[i]?.yogaNode) {
          yogaIndex++;
        }
      }
    }

    node.childNodes.splice(index, 0, newChildNode);

    if (newChildNode.yogaNode && node.yogaNode) {
      node.yogaNode.insertChild(newChildNode.yogaNode, yogaIndex);
    }

    invalidateLayout(node);
    return;
  }

  node.childNodes.push(newChildNode);

  if (newChildNode.yogaNode) {
    node.yogaNode?.insertChild(newChildNode.yogaNode, node.yogaNode.getChildCount());
  }

  invalidateLayout(node);
};

export const removeChild = (node: TreeElement, removeNode: TreeNode): void => {
  if (removeNode.yogaNode) {
    removeNode.parentNode?.yogaNode?.removeChild(removeNode.yogaNode);
  }

  gatherRemovedBounds(node, removeNode);

  removeNode.parentNode = undefined;

  const index = node.childNodes.indexOf(removeNode);
  if (index >= 0) {
    node.childNodes.splice(index, 1);
  }

  invalidateLayout(node);
};

function gatherRemovedBounds(parent: TreeElement, removed: TreeNode, underAbsolute = false): void {
  if (removed.nodeName === "#text") return;
  const elem = removed as TreeElement;

  const isAbsolute = underAbsolute || elem.style.position === "absolute";
  const cached = elementDimensionStore.get(elem);
  if (cached) {
    queueRegionClear(parent, cached, isAbsolute);
    elementDimensionStore.delete(elem);
  }
  for (const child of elem.childNodes) {
    gatherRemovedBounds(parent, child, isAbsolute);
  }
}

export const setNodeAttribute = (
  node: TreeElement,
  key: string,
  value: NodeAttributeValue,
): void => {
  if (key === "children") {
    return;
  }

  if (node.attributes[key] === value) {
    return;
  }
  node.attributes[key] = value;
  invalidateLayout(node);
};

export const setAccessibility = (node: TreeElement, accessibility: any): void => {
  node.accessibility = accessibility;
};

export const applyNodeStyle = (node: TreeNode, style: Styles): void => {
  if (stylesMatch(node.style, style)) {
    return;
  }
  const positionChangedToAbsolute =
    style.position === "absolute" && node.style.position !== "absolute";
  node.style = style;
  if (positionChangedToAbsolute && node.parentNode) {
    markAbsoluteDescendant(node.parentNode);
  }
  invalidateLayout(node);
};

export const applyTextStyle = (node: TreeElement, textStyles: TerminalTextStyle): void => {
  if (shallowMatch(node.textStyles, textStyles)) {
    return;
  }
  node.textStyles = textStyles;
  invalidateLayout(node);
};

function stylesMatch(a: Styles, b: Styles): boolean {
  return shallowMatch(a, b);
}

function shallowMatch<T extends object>(a: T | undefined, b: T | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;

  const aKeys = Object.keys(a) as (keyof T)[];
  const bKeys = Object.keys(b) as (keyof T)[];

  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }

  return true;
}

export const createTextElement = (text: string): TreeTextNode => {
  const node: TreeTextNode = {
    nodeName: "#text",
    nodeValue: text,
    yogaNode: undefined,
    parentNode: undefined,
    style: {},
  };

  updateTextContent(node, text);

  return node;
};

const computeTextDimensions = (
  node: TreeNode,
  width: number,
  widthMode: LayoutMeasurement,
): { width: number; height: number } => {
  const rawText = node.nodeName === "#text" ? node.nodeValue : squashTextNodes(node);

  const text = expandTabs(rawText);

  const dimensions = calculateTextDimensions(text, width);

  if (dimensions.width <= width) {
    return dimensions;
  }

  if (dimensions.width >= 1 && width > 0 && width < 1) {
    return dimensions;
  }

  if (text.includes("\n") && widthMode === LayoutMeasurement.Undefined) {
    const effectiveWidth = Math.max(width, dimensions.width);
    return calculateTextDimensions(text, effectiveWidth);
  }

  const textWrap = node.style?.textWrap ?? "wrap";
  const wrappedText = wrapForDisplay(text, width, textWrap);

  return calculateTextDimensions(wrappedText, width);
};

function wrapForDisplay(
  text: string,
  width: number,
  textWrap: NonNullable<Styles["textWrap"]>,
): string {
  if (textWrap !== "wrap" && textWrap !== "wrap-stream") return wrapText(text, width, textWrap);
  return text
    .split("\n")
    .map((orig) =>
      wrapText(orig, width, "wrap")
        .split("\n")
        .map((piece, i) => (i > 0 ? elideWrapBoundarySpace(piece).line : piece))
        .join("\n"),
    )
    .join("\n");
}

const computeRawAnsiDimensions = (
  node: TreeElement,
): {
  width: number;
  height: number;
} => ({
  width: node.attributes.rawWidth as number,
  height: node.attributes.rawHeight as number,
});

function markAbsoluteDescendant(node: TreeElement): void {
  let current: TreeElement | undefined = node;
  while (current && !current.hasAbsoluteDescendant) {
    current.hasAbsoluteDescendant = true;
    current = current.parentNode;
  }
}

export const invalidateTreeLayout = (node: TreeNode): void => {
  if (node.nodeName !== "#text") {
    const elem = node as TreeElement;
    elem.dirty = true;
    if ((node.nodeName === "ink-text" || node.nodeName === "ink-raw-ansi") && node.yogaNode) {
      node.yogaNode.invalidateLayout();
    }
    for (const child of elem.childNodes) invalidateTreeLayout(child);
  }
};

export const invalidateLayout = (node?: TreeNode): void => {
  let current: TreeNode | undefined = node;
  let markedYoga = false;

  while (current) {
    if (current.nodeName !== "#text") {
      (current as TreeElement).dirty = true;

      if (
        !markedYoga &&
        (current.nodeName === "ink-text" || current.nodeName === "ink-raw-ansi") &&
        current.yogaNode
      ) {
        current.yogaNode.invalidateLayout();
        markedYoga = true;
      }
    }
    current = current.parentNode;
  }
};

export const scheduleRender = (node?: TreeNode): void => {
  let cur: TreeNode | undefined = node;
  while (cur?.parentNode) cur = cur.parentNode;
  if (cur && cur.nodeName !== "#text") (cur as TreeElement).onRender?.();
};

export const updateTextContent = (node: TreeTextNode, text: string): void => {
  if (typeof text !== "string") {
    text = String(text);
  }

  if (node.nodeValue === text) {
    return;
  }

  node.nodeValue = text;
  invalidateLayout(node);
};

function isTreeElement(node: TreeElement | TreeTextNode): node is TreeElement {
  return node.nodeName !== "#text";
}

export const detachLayoutNodes = (node: TreeElement | TreeTextNode): void => {
  if ("childNodes" in node) {
    for (const child of node.childNodes) {
      detachLayoutNodes(child);
    }
  }
  node.yogaNode = undefined;
};

export function findElementAncestorsAtRow(root: TreeElement, y: number): string[] {
  let best: string[] = [];
  walk(root, 0);
  return best;

  function walk(node: TreeElement, offsetY: number): void {
    const yoga = node.yogaNode;
    if (!yoga || yoga.getDisplay() === LayoutVisibility.None) return;

    const top = offsetY + yoga.getComputedTop();
    const height = yoga.getComputedHeight();
    if (y < top || y >= top + height) return;

    if (node.debugOwnerChain) best = node.debugOwnerChain;

    for (const child of node.childNodes) {
      if (isTreeElement(child)) walk(child, top);
    }
  }
}

export function renderAccessibilityText(
  node: TreeElement | TreeTextNode,
  parentRole?: string,
): string {
  if (node.nodeName === "#text") {
    return (node as TreeTextNode).nodeValue;
  }
  const el = node as TreeElement;
  const q = el.accessibility;
  if (q?.hidden) return "";
  if (el.isHidden || el.yogaNode?.getDisplay() === LayoutVisibility.None) return "";

  let K = "";
  if (q?.label !== undefined) {
    K = q.label;
  } else if (
    el.nodeName === "ink-text" ||
    el.nodeName === "ink-virtual-text" ||
    el.nodeName === "ink-link"
  ) {
    for (const child of el.childNodes) {
      K += renderAccessibilityText(child, q?.role ?? parentRole);
    }
  } else if (el.nodeName === "ink-box" || el.nodeName === "ink-root") {
    K = renderAccessibilityChildren(el, q?.role ?? parentRole);
  }

  if (q?.state) {
    const activeStates = Object.keys(q.state).filter((k) => q.state[k]);
    if (activeStates.length > 0) {
      K = `(${activeStates.join(", ")}) ${K}`;
    }
  }

  if (q?.role && q.role !== parentRole) {
    K = `${q.role}: ${K}`;
  }

  return K;
}

function renderAccessibilityChildren(el: TreeElement, parentRole?: string): string {
  const dir = el.style.flexDirection ?? "row";
  const isColumn = dir === "column" || dir === "column-reverse";
  const isReverseDirection = dir === "row-reverse" || dir === "column-reverse";
  const sep = isColumn ? "\n" : " ";
  const results: string[] = [];

  for (const child of el.childNodes) {
    const text = renderAccessibilityText(child, parentRole);
    if (text !== "") {
      results.push(text);
    }
  }

  if (isReverseDirection) {
    results.reverse();
  }

  return results.join(sep);
}

export type NodeRectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
};

export const nodeRectangles: WeakMap<TreeElement, NodeRectangle> = new WeakMap();

export const releaseNodeRectangles = (node: TreeElement): void => {
  nodeRectangles.delete(node);
  for (const child of node.childNodes) {
    if (child.nodeName !== "#text") {
      releaseNodeRectangles(child as TreeElement);
    }
  }
};

export type RenderContext = {
  displayLayoutDirty: boolean;
  positionedRectsCurrent: NodeRectangle[];
};

export const createRenderContext = (): RenderContext => ({
  displayLayoutDirty: false,
  positionedRectsCurrent: [],
});

const RNS_OSC = "]";
const RNS_BEL = "";

enum RnsSoftWrap {
  HardBreak = 0,
  Continuation = 1,
  ContinuationElidedSep = 2,
}

let rnsSegmentMapScratch = new Uint32Array(1024);

function rnsInnerWidth(yogaNode: LayoutElement): number {
  return (
    yogaNode.getComputedWidth() -
    yogaNode.getComputedPadding(LayoutSide.Left) -
    yogaNode.getComputedPadding(LayoutSide.Right) -
    yogaNode.getComputedBorder(LayoutSide.Left) -
    yogaNode.getComputedBorder(LayoutSide.Right)
  );
}

function rnsWrapOsc8Link(text: string, url: string): string {
  return `${RNS_OSC}8;;${url}${RNS_BEL}${text}${RNS_OSC}8;;${RNS_BEL}`;
}

function rnsStyleText(text: string, styles: TerminalTextStyle): string {
  return renderTextWithStyles(text, styles);
}

function rnsBuildSegmentMap(segments: StyledSegment[]): Uint32Array {
  let totalChars = 0;
  for (let i = 0; i < segments.length; i++) {
    totalChars += segments[i]!.text.length;
  }
  if (rnsSegmentMapScratch.length < totalChars) {
    rnsSegmentMapScratch = new Uint32Array(Math.max(totalChars, rnsSegmentMapScratch.length * 2));
  }
  const map = rnsSegmentMapScratch.subarray(0, totalChars);
  let offset = 0;
  for (let i = 0; i < segments.length; i++) {
    const end = offset + segments[i]!.text.length;
    map.fill(i, offset, end);
    offset = end;
  }
  return map;
}

function rnsApplyStylesToWrappedText(
  wrappedPlain: string,
  segments: StyledSegment[],
  segmentMap: Uint32Array,
  originalPlain: string,
  trimEnabled: boolean,
  softWrap: RnsSoftWrap[] | undefined,
): string {
  const lines = wrappedPlain.split("\n");
  const out: string[] = [];
  let origIndex = 0;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;

    if (trimEnabled && line.length > 0) {
      const lineStartsWs = /\s/.test(line[0]!);
      if (
        origIndex < originalPlain.length &&
        /\s/.test(originalPlain[origIndex]!) &&
        !lineStartsWs
      ) {
        while (origIndex < originalPlain.length && /\s/.test(originalPlain[origIndex]!)) {
          origIndex++;
        }
      }
    }

    let styledLine = "";
    let runStart = 0;
    let runSegment = segmentMap[origIndex] ?? 0;

    for (let i = 0; i < line.length; i++) {
      const cur = segmentMap[origIndex] ?? runSegment;
      if (cur !== runSegment) {
        const runText = line.slice(runStart, i);
        const seg = segments[runSegment];
        if (seg) {
          let styled = rnsStyleText(runText, seg.styles);
          if (seg.hyperlink) styled = rnsWrapOsc8Link(styled, seg.hyperlink);
          styledLine += styled;
        } else {
          styledLine += runText;
        }
        runStart = i;
        runSegment = cur;
      }
      origIndex++;
    }

    const tailText = line.slice(runStart);
    const tailSeg = segments[runSegment];
    if (tailSeg) {
      let styled = rnsStyleText(tailText, tailSeg.styles);
      if (tailSeg.hyperlink) styled = rnsWrapOsc8Link(styled, tailSeg.hyperlink);
      styledLine += styled;
    } else {
      styledLine += tailText;
    }
    out.push(styledLine);

    if (origIndex < originalPlain.length && originalPlain[origIndex] === "\r") {
      origIndex++;
    }
    if (origIndex < originalPlain.length && originalPlain[origIndex] === "\n") {
      origIndex++;
    }

    if (
      softWrap?.[lineIdx + 1] === RnsSoftWrap.ContinuationElidedSep &&
      origIndex < originalPlain.length &&
      originalPlain[origIndex] === " "
    ) {
      origIndex++;
    }

    if (trimEnabled && lineIdx < lines.length - 1) {
      const nextLine = lines[lineIdx + 1]!;
      const nextFirst = nextLine.length > 0 ? nextLine[0] : null;
      while (origIndex < originalPlain.length && /\s/.test(originalPlain[origIndex]!)) {
        if (nextFirst !== null && originalPlain[origIndex] === nextFirst) break;
        origIndex++;
      }
    }
  }

  return out.join("\n");
}

function rnsWrapWithSoftWrap(
  plainText: string,
  maxWidth: number,
  textWrap: NonNullable<Styles["textWrap"]>,
): { wrapped: string; softWrap: RnsSoftWrap[] | undefined } {
  const isStream = textWrap === "wrap-stream";
  if (textWrap !== "wrap" && textWrap !== "wrap-trim" && !isStream) {
    return {
      wrapped: wrapText(plainText, maxWidth, textWrap),
      softWrap: undefined,
    };
  }
  const effectiveMode = isStream ? ("wrap" as const) : (textWrap as "wrap" | "wrap-trim");
  const origLines = plainText.replace(/\r\n?/g, "\n").split("\n");
  const outLines: string[] = [];
  const sw: RnsSoftWrap[] = [];
  for (const orig of origLines) {
    const pieces = wrapText(orig, maxWidth, effectiveMode).split("\n");
    for (let i = 0; i < pieces.length; i++) {
      if (i === 0) {
        outLines.push(pieces[i]!);
        sw.push(RnsSoftWrap.HardBreak);
        continue;
      }
      const result = elideWrapBoundarySpace(pieces[i]!);
      outLines.push(result.line);
      sw.push(result.elided ? RnsSoftWrap.ContinuationElidedSep : RnsSoftWrap.Continuation);
    }
  }
  if (isStream) {
    outLines.pop();
    sw.pop();
  }
  return { wrapped: outLines.join("\n"), softWrap: sw };
}

function rnsApplyPaddingToText(
  node: TreeElement,
  text: string,
  softWrap: RnsSoftWrap[] | undefined,
): string {
  const firstYoga = node.childNodes[0]?.yogaNode;
  if (firstYoga) {
    const offsetX = firstYoga.getComputedLeft();
    const offsetY = firstYoga.getComputedTop();
    text = "\n".repeat(offsetY) + indentString(text, offsetX);
    if (softWrap && offsetY > 0) {
      softWrap.unshift(...Array<RnsSoftWrap>(offsetY).fill(RnsSoftWrap.HardBreak));
    }
  }
  return text;
}

function rnsSiblingSharesY(node: TreeElement, yogaNode: LayoutElement): boolean {
  const parent = node.parentNode;
  if (!parent) return false;
  const myTop = yogaNode.getComputedTop();
  const siblings = parent.childNodes;
  const idx = siblings.indexOf(node);
  for (let i = idx + 1; i < siblings.length; i++) {
    const sib = (siblings[i] as TreeElement).yogaNode;
    if (!sib) continue;
    return sib.getComputedTop() === myTop;
  }
  for (let i = idx - 1; i >= 0; i--) {
    const sib = (siblings[i] as TreeElement).yogaNode;
    if (!sib) continue;
    return sib.getComputedTop() === myTop;
  }
  return false;
}

function rnsRefreshSubtreeRects(node: TreeElement, offsetX: number, offsetY: number): void {
  const yoga = node.yogaNode;
  if (!yoga || yoga.getDisplay() === LayoutVisibility.None) return;
  const x = offsetX + yoga.getComputedLeft();
  const y = offsetY + yoga.getComputedTop();
  nodeRectangles.set(node, {
    x,
    y,
    width: yoga.getComputedWidth(),
    height: yoga.getComputedHeight(),
    top: yoga.getComputedTop(),
  });
  for (const child of node.childNodes) {
    if (child.nodeName !== "#text") {
      rnsRefreshSubtreeRects(child as TreeElement, x, y);
    }
  }
}

function rnsBlitEscapingAbsolute(
  node: TreeElement,
  drawing: DrawingOps,
  ctx: RenderContext,
  prevScreen: Screen,
  px: number,
  py: number,
  pw: number,
  ph: number,
): void {
  const pr = px + pw;
  const pb = py + ph;
  for (const child of node.childNodes) {
    if (child.nodeName === "#text") continue;
    const elem = child as TreeElement;
    if (elem.style.position === "absolute") {
      const cached = nodeRectangles.get(elem);
      if (cached) {
        ctx.positionedRectsCurrent.push(cached);
        const cx = Math.floor(cached.x);
        const cy = Math.floor(cached.y);
        const cw = Math.floor(cached.width);
        const ch = Math.floor(cached.height);
        if (cx < px || cy < py || cx + cw > pr || cy + ch > pb) {
          drawing.blit(prevScreen, cx, cy, cw, ch);
        }
      }
    }
    rnsBlitEscapingAbsolute(elem, drawing, ctx, prevScreen, px, py, pw, ph);
  }
}

function rnsAnyAbsoluteShifted(node: TreeElement, offsetX: number, offsetY: number): boolean {
  for (const child of node.childNodes) {
    const elem = child as TreeElement;
    if (elem.style.position !== "absolute") continue;
    const yoga = elem.yogaNode;
    if (!yoga || yoga.getDisplay() === LayoutVisibility.None) continue;
    const cached = nodeRectangles.get(elem);
    if (!cached) continue;
    const cx = offsetX + yoga.getComputedLeft();
    let cy = offsetY + yoga.getComputedTop();
    if (cy < 0) cy = 0;
    if (
      cached.x !== cx ||
      cached.y !== cy ||
      cached.width !== yoga.getComputedWidth() ||
      cached.height !== yoga.getComputedHeight()
    ) {
      return true;
    }
  }
  return false;
}

function rnsClipsBothAxes(node: TreeElement): boolean {
  const ox = node.style.overflowX ?? node.style.overflow;
  const oy = node.style.overflowY ?? node.style.overflow;
  return ox === "hidden" && oy === "hidden";
}

function rnsRenderChildren(
  node: TreeElement,
  drawing: DrawingOps,
  ctx: RenderContext,
  offsetX: number,
  offsetY: number,
  hasRemovedChild: boolean,
  prevScreen: Screen | undefined,
  inheritedBackgroundColor: TerminalColor | undefined,
): void {
  const absoluteShifted = prevScreen !== undefined && rnsAnyAbsoluteShifted(node, offsetX, offsetY);
  let seenDirtyChild = false;
  let seenDirtyClipped = false;
  for (const childNode of node.childNodes) {
    const childElem = childNode as TreeElement;
    const wasDirty = childElem.dirty;
    const isAbsolute = childElem.style.position === "absolute";
    renderNodeToScreen(childElem, drawing, ctx, {
      offsetX,
      offsetY,
      prevScreen:
        hasRemovedChild || seenDirtyChild || (absoluteShifted && !isAbsolute)
          ? undefined
          : prevScreen,
      skipSelfBlit:
        seenDirtyClipped &&
        isAbsolute &&
        !childElem.style.opaque &&
        childElem.style.backgroundColor === undefined,
      inheritedBackgroundColor,
    });
    if (wasDirty && !seenDirtyChild) {
      if (!rnsClipsBothAxes(childElem) || isAbsolute) {
        seenDirtyChild = true;
      } else {
        seenDirtyClipped = true;
      }
    }
  }
}

function rnsPaintPostHooks(x: number, y: number, node: TreeElement, drawing: DrawingOps): void {
  renderBorder(x, y, node, drawing);
}

export function renderNodeToScreen(
  node: TreeElement,
  drawing: DrawingOps,
  ctx: RenderContext,
  {
    offsetX = 0,
    offsetY = 0,
    prevScreen,
    skipSelfBlit = false,
    inheritedBackgroundColor,
  }: {
    offsetX?: number;
    offsetY?: number;
    prevScreen?: Screen | undefined;
    skipSelfBlit?: boolean;
    inheritedBackgroundColor?: TerminalColor | undefined;
  },
): void {
  const { yogaNode } = node;
  if (!yogaNode) return;

  if (yogaNode.getDisplay() === LayoutVisibility.None) {
    if (node.dirty) {
      const cached = nodeRectangles.get(node);
      if (cached) {
        drawing.clear({
          x: Math.floor(cached.x),
          y: Math.floor(cached.y),
          width: Math.floor(cached.width),
          height: Math.floor(cached.height),
        });
        releaseNodeRectangles(node);
        ctx.displayLayoutDirty = true;
      }
    }
    return;
  }

  const x = offsetX + yogaNode.getComputedLeft();
  const yogaTop = yogaNode.getComputedTop();
  let y = offsetY + yogaTop;
  const width = yogaNode.getComputedWidth();
  const height = yogaNode.getComputedHeight();

  if (y < 0 && node.style.position === "absolute") {
    y = 0;
  }

  const cached = nodeRectangles.get(node);

  if (
    !node.dirty &&
    !skipSelfBlit &&
    cached &&
    cached.x === x &&
    cached.y === y &&
    cached.width === width &&
    cached.height === height &&
    prevScreen
  ) {
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const fw = Math.floor(width);
    const fh = Math.floor(height);
    drawing.blit(prevScreen, fx, fy, fw, fh);
    if (node.style.position === "absolute") {
      ctx.positionedRectsCurrent.push(cached);
    }
    rnsBlitEscapingAbsolute(node, drawing, ctx, prevScreen, fx, fy, fw, fh);
    return;
  }

  const positionChanged =
    cached !== undefined &&
    (cached.x !== x || cached.y !== y || cached.width !== width || cached.height !== height);
  if (positionChanged) {
    ctx.displayLayoutDirty = true;
  }
  if (cached && (node.dirty || positionChanged)) {
    drawing.clear(
      {
        x: Math.floor(cached.x),
        y: Math.floor(cached.y),
        width: Math.floor(cached.width),
        height: Math.floor(cached.height),
      },
      node.style.position === "absolute",
    );
  }

  const removedRects = deferredRegions.get(node);
  const hasRemovedChild = removedRects !== undefined;
  if (hasRemovedChild) {
    ctx.displayLayoutDirty = true;
    for (const rect of removedRects) {
      drawing.clear({
        x: Math.floor(rect.x),
        y: Math.floor(rect.y),
        width: Math.floor(rect.width),
        height: Math.floor(rect.height),
      });
    }
    deferredRegions.delete(node);
  }

  if (height === 0 && rnsSiblingSharesY(node, yogaNode)) {
    nodeRectangles.set(node, { x, y, width, height, top: yogaTop });
    for (const child of node.childNodes) {
      if (child.nodeName !== "#text") {
        rnsRefreshSubtreeRects(child as TreeElement, x, y);
      }
    }
    node.dirty = false;
    return;
  }

  if (node.nodeName === "ink-raw-ansi") {
    const text = node.attributes.rawText as string | undefined;
    if (text) {
      drawing.write(x, y, text);
    }
  } else if (node.nodeName === "ink-text") {
    const segments = squashTextNodesToSegments(
      node,
      inheritedBackgroundColor ? { backgroundColor: inheritedBackgroundColor } : undefined,
    );
    const plain = segments.map((s) => s.text).join("");
    if (plain.length > 0) {
      const maxWidth = Math.min(rnsInnerWidth(yogaNode), drawing.width - x);
      const textWrap = node.style.textWrap ?? "wrap";
      const isStream = textWrap === "wrap-stream";
      const needsWrap = isStream || widestLine(plain) > maxWidth;

      let text: string;
      let softWrap: RnsSoftWrap[] | undefined;
      if (needsWrap && segments.length === 1) {
        const seg = segments[0]!;
        const w = rnsWrapWithSoftWrap(plain, maxWidth, textWrap);
        softWrap = w.softWrap;
        text = w.wrapped
          .split("\n")
          .map((line) => {
            let styled = rnsStyleText(line, seg.styles);
            if (seg.hyperlink) styled = rnsWrapOsc8Link(styled, seg.hyperlink);
            return styled;
          })
          .join("\n");
      } else if (needsWrap) {
        const w = rnsWrapWithSoftWrap(plain, maxWidth, textWrap);
        softWrap = w.softWrap;
        const segMap = rnsBuildSegmentMap(segments);
        text = rnsApplyStylesToWrappedText(
          w.wrapped,
          segments,
          segMap,
          plain,
          textWrap === "wrap-trim",
          w.softWrap,
        );
      } else {
        text = segments
          .map((seg) => {
            let styled = rnsStyleText(seg.text, seg.styles);
            if (seg.hyperlink) styled = rnsWrapOsc8Link(styled, seg.hyperlink);
            return styled;
          })
          .join("");
      }

      text = rnsApplyPaddingToText(node, text, softWrap);
      drawing.write(
        x,
        y,
        text,
        softWrap?.map((s) => s !== RnsSoftWrap.HardBreak),
      );
    }
  } else if (node.nodeName === "ink-box") {
    const boxBackgroundColor = node.style.backgroundColor ?? inheritedBackgroundColor;

    const overflowX = node.style.overflowX ?? node.style.overflow;
    const overflowY = node.style.overflowY ?? node.style.overflow;
    const clipHorizontally = overflowX === "hidden";
    const clipVertically = overflowY === "hidden";
    const needsClip = clipHorizontally || clipVertically;

    let y1: number | undefined;
    let y2: number | undefined;
    if (needsClip) {
      const x1 = clipHorizontally ? x + yogaNode.getComputedBorder(LayoutSide.Left) : undefined;
      const x2 = clipHorizontally
        ? x + yogaNode.getComputedWidth() - yogaNode.getComputedBorder(LayoutSide.Right)
        : undefined;
      y1 = clipVertically ? y + yogaNode.getComputedBorder(LayoutSide.Top) : undefined;
      y2 = clipVertically
        ? y + yogaNode.getComputedHeight() - yogaNode.getComputedBorder(LayoutSide.Bottom)
        : undefined;
      drawing.clip({ x1, x2, y1, y2 });
    }

    const ownBackgroundColor = node.style.backgroundColor;
    if (ownBackgroundColor || node.style.opaque) {
      const borderLeft = yogaNode.getComputedBorder(LayoutSide.Left);
      const borderRight = yogaNode.getComputedBorder(LayoutSide.Right);
      const borderTop = yogaNode.getComputedBorder(LayoutSide.Top);
      const borderBottom = yogaNode.getComputedBorder(LayoutSide.Bottom);
      const innerWidth = Math.floor(width) - borderLeft - borderRight;
      const innerH = Math.floor(height) - borderTop - borderBottom;
      if (innerWidth > 0 && innerH > 0) {
        const spaces = " ".repeat(innerWidth);
        const fillLine = ownBackgroundColor
          ? rnsStyleText(spaces, { backgroundColor: ownBackgroundColor })
          : spaces;
        const fill = Array(innerH).fill(fillLine).join("\n");
        drawing.write(x + borderLeft, y + borderTop, fill);
      }
    }

    rnsRenderChildren(
      node,
      drawing,
      ctx,
      x,
      y,
      hasRemovedChild,
      ownBackgroundColor || node.style.opaque ? undefined : prevScreen,
      boxBackgroundColor,
    );

    if (needsClip) {
      drawing.unclip();
    }

    rnsPaintPostHooks(x, y, node, drawing);
  } else if (node.nodeName === "ink-root") {
    rnsRenderChildren(
      node,
      drawing,
      ctx,
      x,
      y,
      hasRemovedChild,
      prevScreen,
      inheritedBackgroundColor,
    );
  }

  const rect: NodeRectangle = { x, y, width, height, top: yogaTop };
  nodeRectangles.set(node, rect);
  if (node.style.position === "absolute") {
    ctx.positionedRectsCurrent.push(rect);
  }
  node.dirty = false;
}

export function findAccessibilityNodeOffset(
  root: TreeElement | TreeTextNode,
  target: TreeElement | TreeTextNode,
  parentRole?: string,
): number | null {
  if (root === target) {
    return 0;
  }
  if (root.nodeName === "#text") {
    return null;
  }
  const el = root as TreeElement;
  const q = el.accessibility;
  if (q?.hidden) return null;
  if (el.isHidden || el.yogaNode?.getDisplay() === LayoutVisibility.None) return null;
  if (q?.label !== undefined) return null;
  if (
    el.nodeName === "ink-text" ||
    el.nodeName === "ink-virtual-text" ||
    el.nodeName === "ink-link"
  ) {
    return null;
  }
  if (el.nodeName !== "ink-box" && el.nodeName !== "ink-root") {
    return null;
  }

  const role = q?.role ?? parentRole;
  let prefixLen = 0;

  if (q?.state) {
    const activeStates = Object.keys(q.state).filter((k) => q.state[k]);
    if (activeStates.length > 0) {
      prefixLen += `(${activeStates.join(", ")}) `.length;
    }
  }

  if (q?.role && q.role !== parentRole) {
    prefixLen += `${q.role}: `.length;
  }

  const dir = el.style.flexDirection ?? "row";
  const isColumn = dir === "column" || dir === "column-reverse";
  const isReverseDirection = dir === "row-reverse" || dir === "column-reverse";
  const sepLen = isColumn ? 1 : 1;

  const childrenWithText: Array<{ node: TreeNode; out: string }> = [];
  for (const child of el.childNodes) {
    const text = renderAccessibilityText(child, role);
    if (text !== "") {
      childrenWithText.push({ node: child, out: text });
    }
  }

  if (isReverseDirection) {
    childrenWithText.reverse();
  }

  let offset = 0;
  for (const item of childrenWithText) {
    const innerOffset = findAccessibilityNodeOffset(item.node, target, role);
    if (innerOffset !== null) {
      return prefixLen + offset + innerOffset;
    }
    offset += item.out.length + sepLen;
  }

  return null;
}
