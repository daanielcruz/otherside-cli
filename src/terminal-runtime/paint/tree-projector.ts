import indentString from "indent-string";
import computeAvailableWidth from "@/terminal-runtime/geometry/content-width.js";
import {
  type LayoutElement,
  LayoutSide,
  LayoutVisibility,
} from "@/terminal-runtime/geometry/layout-element.js";
import renderBorder from "@/terminal-runtime/paint/border-strokes.js";
import type { Screen } from "@/terminal-runtime/paint/cell-grid.js";
import type Output from "@/terminal-runtime/paint/line-composer.js";
import type { TerminalColor } from "@/terminal-runtime/paint/style-model.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import wrapText, { elideWrapBoundarySpace } from "@/terminal-runtime/text/line-fold.js";
import { widestLine } from "@/terminal-runtime/text/max-line-width.js";
import type { TreeElement } from "@/terminal-runtime/tree/elements.js";
import { deferredRegions, elementDimensionStore } from "@/terminal-runtime/tree/layout-cache.js";
import {
  type StyledSegment,
  squashTextNodesToSegments,
} from "@/terminal-runtime/tree/text-coalescing.js";

let displayLayoutDirty = false;

export function resetDisplayLayout(): void {
  displayLayoutDirty = false;
}

export function hasLayoutChanged(): boolean {
  return displayLayoutDirty;
}

const OSC = "\u001B]";
const BEL = "\u0007";

function embedHyperlinkAnsi(text: string, url: string): string {
  return `${OSC}8;;${url}${BEL}${text}${OSC}8;;${BEL}`;
}

function mapCharToSegmentIndex(segments: StyledSegment[]): number[] {
  const map: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    const len = segments[i]!.text.length;
    for (let j = 0; j < len; j++) {
      map.push(i);
    }
  }
  return map;
}

function applyFormattingToWrappedText(
  wrappedPlain: string,
  segments: StyledSegment[],
  charToSegment: number[],
  originalPlain: string,
  trimEnabled: boolean = false,
  elided?: boolean[],
): string {
  const lines = wrappedPlain.split("\n");
  const resultLines: string[] = [];

  let charIndex = 0;
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;

    if (elided?.[lineIdx] && charIndex < originalPlain.length && originalPlain[charIndex] === " ") {
      charIndex++;
    }

    if (trimEnabled && line.length > 0) {
      const lineStartsWithWhitespace = /\s/.test(line[0]!);
      const originalHasWhitespace =
        charIndex < originalPlain.length && /\s/.test(originalPlain[charIndex]!);

      if (originalHasWhitespace && !lineStartsWithWhitespace) {
        while (charIndex < originalPlain.length && /\s/.test(originalPlain[charIndex]!)) {
          charIndex++;
        }
      }
    }

    let styledLine = "";
    let runStart = 0;
    let runSegmentIndex = charToSegment[charIndex] ?? 0;

    for (let i = 0; i < line.length; i++) {
      const currentSegmentIndex = charToSegment[charIndex] ?? runSegmentIndex;

      if (currentSegmentIndex !== runSegmentIndex) {
        const runText = line.slice(runStart, i);
        const segment = segments[runSegmentIndex];
        if (segment) {
          let styled = renderTextWithStyles(runText, segment.styles);
          if (segment.hyperlink) {
            styled = embedHyperlinkAnsi(styled, segment.hyperlink);
          }
          styledLine += styled;
        } else {
          styledLine += runText;
        }
        runStart = i;
        runSegmentIndex = currentSegmentIndex;
      }

      charIndex++;
    }

    const runText = line.slice(runStart);
    const segment = segments[runSegmentIndex];
    if (segment) {
      let styled = renderTextWithStyles(runText, segment.styles);
      if (segment.hyperlink) {
        styled = embedHyperlinkAnsi(styled, segment.hyperlink);
      }
      styledLine += styled;
    } else {
      styledLine += runText;
    }

    resultLines.push(styledLine);

    if (charIndex < originalPlain.length && originalPlain[charIndex] === "\n") {
      charIndex++;
    }

    if (trimEnabled && lineIdx < lines.length - 1) {
      const nextLine = lines[lineIdx + 1]!;
      const nextLineFirstChar = nextLine.length > 0 ? nextLine[0] : null;

      while (charIndex < originalPlain.length && /\s/.test(originalPlain[charIndex]!)) {
        if (nextLineFirstChar !== null && originalPlain[charIndex] === nextLineFirstChar) {
          break;
        }
        charIndex++;
      }
    }
  }

  return resultLines.join("\n");
}

function wrapTextWithSoftBreaks(
  plainText: string,
  maxWidth: number,
  textWrap: Parameters<typeof wrapText>[2],
): { wrapped: string; softWrap: boolean[] | undefined; elided: boolean[] | undefined } {
  const isStream = textWrap === "wrap-stream";
  if (textWrap !== "wrap" && textWrap !== "wrap-trim" && !isStream) {
    return {
      wrapped: wrapText(plainText, maxWidth, textWrap),
      softWrap: undefined,
      elided: undefined,
    };
  }
  const origLines = plainText.split("\n");
  const outLines: string[] = [];
  const softWrap: boolean[] = [];
  const elided: boolean[] = [];
  for (const orig of origLines) {
    const pieces = wrapText(orig, maxWidth, textWrap).split("\n");
    for (let i = 0; i < pieces.length; i++) {
      if (i > 0 && textWrap !== "wrap-trim") {
        const result = elideWrapBoundarySpace(pieces[i]!);
        outLines.push(result.line);
        elided.push(result.elided);
      } else {
        outLines.push(pieces[i]!);
        elided.push(false);
      }
      softWrap.push(i > 0);
    }
  }
  if (isStream) {
    outLines.pop();
    softWrap.pop();
    elided.pop();
  }
  return { wrapped: outLines.join("\n"), softWrap, elided };
}

function applyOffsetToText(node: TreeElement, text: string, softWrap?: boolean[]): string {
  const yogaNode = node.childNodes[0]?.yogaNode;

  if (yogaNode) {
    const offsetX = yogaNode.getComputedLeft();
    const offsetY = yogaNode.getComputedTop();
    text = "\n".repeat(offsetY) + indentString(text, offsetX);
    if (softWrap && offsetY > 0) {
      softWrap.unshift(...Array<boolean>(offsetY).fill(false));
    }
  }

  return text;
}

function renderNodeToBuffer(
  node: TreeElement,
  output: Output,
  {
    offsetX = 0,
    offsetY = 0,
    prevScreen,
    skipSelfBlit = false,
    inheritedBackgroundColor,
  }: {
    offsetX?: number;
    offsetY?: number;
    prevScreen: Screen | undefined;

    skipSelfBlit?: boolean;
    inheritedBackgroundColor?: TerminalColor | undefined;
  },
): void {
  const { yogaNode } = node;

  if (yogaNode) {
    if (yogaNode.getDisplay() === LayoutVisibility.None) {
      if (node.dirty) {
        const cached = elementDimensionStore.get(node);
        if (cached) {
          output.clear({
            x: Math.floor(cached.x),
            y: Math.floor(cached.y),
            width: Math.floor(cached.width),
            height: Math.floor(cached.height),
          });

          clearSubtreeCache(node);
          displayLayoutDirty = true;
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

    const cached = elementDimensionStore.get(node);
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
      output.blit(prevScreen, fx, fy, fw, fh);

      copyOverflowingPositionedElements(node, output, prevScreen, fx, fy, fw, fh);
      return;
    }

    const positionChanged =
      cached !== undefined &&
      (cached.x !== x || cached.y !== y || cached.width !== width || cached.height !== height);
    if (positionChanged) {
      displayLayoutDirty = true;
    }
    if (cached && (node.dirty || positionChanged)) {
      output.clear(
        {
          x: Math.floor(cached.x),
          y: Math.floor(cached.y),
          width: Math.floor(cached.width),
          height: Math.floor(cached.height),
        },
        node.style.position === "absolute",
      );
    }

    const clears = deferredRegions.get(node);
    const hasRemovedChild = clears !== undefined;
    if (hasRemovedChild) {
      displayLayoutDirty = true;
      for (const rect of clears) {
        output.clear({
          x: Math.floor(rect.x),
          y: Math.floor(rect.y),
          width: Math.floor(rect.width),
          height: Math.floor(rect.height),
        });
      }
      deferredRegions.delete(node);
    }

    if (height === 0 && siblingHasSameLine(node, yogaNode)) {
      elementDimensionStore.set(node, { x, y, width, height, top: yogaTop });
      node.dirty = false;
      return;
    }

    if (node.nodeName === "ink-raw-ansi") {
      const text = node.attributes.rawText as string;
      if (text) {
        output.write(x, y, text);
      }
    } else if (node.nodeName === "ink-text") {
      const segments = squashTextNodesToSegments(
        node,
        inheritedBackgroundColor ? { backgroundColor: inheritedBackgroundColor } : undefined,
      );

      const plainText = segments.map((s) => s.text).join("");

      if (plainText.length > 0) {
        const maxWidth = Math.min(computeAvailableWidth(yogaNode), output.width - x);
        const textWrap = node.style.textWrap ?? "wrap";

        const needsWrapping = textWrap === "wrap-stream" || widestLine(plainText) > maxWidth;

        let text: string;
        let softWrap: boolean[] | undefined;
        if (needsWrapping && segments.length === 1) {
          const segment = segments[0]!;
          const w = wrapTextWithSoftBreaks(plainText, maxWidth, textWrap);
          softWrap = w.softWrap;
          text = w.wrapped
            .split("\n")
            .map((line) => {
              let styled = renderTextWithStyles(line, segment.styles);

              if (segment.hyperlink) {
                styled = embedHyperlinkAnsi(styled, segment.hyperlink);
              }
              return styled;
            })
            .join("\n");
        } else if (needsWrapping) {
          const w = wrapTextWithSoftBreaks(plainText, maxWidth, textWrap);
          softWrap = w.softWrap;
          const charToSegment = mapCharToSegmentIndex(segments);
          text = applyFormattingToWrappedText(
            w.wrapped,
            segments,
            charToSegment,
            plainText,
            textWrap === "wrap-trim",
            w.elided,
          );
        } else {
          text = segments
            .map((segment) => {
              let styledText = renderTextWithStyles(segment.text, segment.styles);
              if (segment.hyperlink) {
                styledText = embedHyperlinkAnsi(styledText, segment.hyperlink);
              }
              return styledText;
            })
            .join("");
        }

        text = applyOffsetToText(node, text, softWrap);

        output.write(x, y, text, softWrap);
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

        output.clip({ x1, x2, y1, y2 });
      }

      const ownBackgroundColor = node.style.backgroundColor;
      if (ownBackgroundColor || node.style.opaque) {
        const borderLeft = yogaNode.getComputedBorder(LayoutSide.Left);
        const borderRight = yogaNode.getComputedBorder(LayoutSide.Right);
        const borderTop = yogaNode.getComputedBorder(LayoutSide.Top);
        const borderBottom = yogaNode.getComputedBorder(LayoutSide.Bottom);
        const innerWidth = Math.floor(width) - borderLeft - borderRight;
        const innerHeight = Math.floor(height) - borderTop - borderBottom;
        if (innerWidth > 0 && innerHeight > 0) {
          const spaces = " ".repeat(innerWidth);
          const fillLine = ownBackgroundColor
            ? renderTextWithStyles(spaces, { backgroundColor: ownBackgroundColor })
            : spaces;
          const fill = Array(innerHeight).fill(fillLine).join("\n");
          output.write(x + borderLeft, y + borderTop, fill);
        }
      }

      renderChildNodes(
        node,
        output,
        x,
        y,
        hasRemovedChild,

        ownBackgroundColor || node.style.opaque ? undefined : prevScreen,
        boxBackgroundColor,
      );

      if (needsClip) {
        output.unclip();
      }

      renderBorder(x, y, node, output);
    } else if (node.nodeName === "ink-root") {
      renderChildNodes(node, output, x, y, hasRemovedChild, prevScreen, inheritedBackgroundColor);
    }

    const rect = { x, y, width, height, top: yogaTop };
    elementDimensionStore.set(node, rect);
    node.dirty = false;
  }
}

function renderChildNodes(
  node: TreeElement,
  output: Output,
  offsetX: number,
  offsetY: number,
  hasRemovedChild: boolean,
  prevScreen: Screen | undefined,
  inheritedBackgroundColor: TerminalColor | undefined,
): void {
  let seenDirtyChild = false;
  let seenDirtyClipped = false;
  for (const childNode of node.childNodes) {
    const childElem = childNode as TreeElement;

    const wasDirty = childElem.dirty;
    const isAbsolute = childElem.style.position === "absolute";
    renderNodeToBuffer(childElem, output, {
      offsetX,
      offsetY,
      prevScreen: hasRemovedChild || seenDirtyChild ? undefined : prevScreen,

      skipSelfBlit:
        seenDirtyClipped &&
        isAbsolute &&
        !childElem.style.opaque &&
        childElem.style.backgroundColor === undefined,
      inheritedBackgroundColor,
    });
    if (wasDirty && !seenDirtyChild) {
      if (!isClippedBidirectional(childElem) || isAbsolute) {
        seenDirtyChild = true;
      } else {
        seenDirtyClipped = true;
      }
    }
  }
}

function isClippedBidirectional(node: TreeElement): boolean {
  const ox = node.style.overflowX ?? node.style.overflow;
  const oy = node.style.overflowY ?? node.style.overflow;
  return ox === "hidden" && oy === "hidden";
}

function siblingHasSameLine(node: TreeElement, yogaNode: LayoutElement): boolean {
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

function copyOverflowingPositionedElements(
  node: TreeElement,
  output: Output,
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
      const cached = elementDimensionStore.get(elem);
      if (cached) {
        const cx = Math.floor(cached.x);
        const cy = Math.floor(cached.y);
        const cw = Math.floor(cached.width);
        const ch = Math.floor(cached.height);

        if (cx < px || cy < py || cx + cw > pr || cy + ch > pb) {
          output.blit(prevScreen, cx, cy, cw, ch);
        }
      }
    }

    copyOverflowingPositionedElements(elem, output, prevScreen, px, py, pw, ph);
  }
}

function clearSubtreeCache(node: TreeElement): void {
  elementDimensionStore.delete(node);
  for (const child of node.childNodes) {
    if (child.nodeName !== "#text") {
      clearSubtreeCache(child as TreeElement);
    }
  }
}

export { applyFormattingToWrappedText, mapCharToSegmentIndex };

export default renderNodeToBuffer;
