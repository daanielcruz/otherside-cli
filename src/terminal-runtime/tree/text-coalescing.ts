import type { TerminalTextStyle } from "@/terminal-runtime/paint/style-model.js";
import type { TreeElement } from "@/terminal-runtime/tree/elements.js";

export type StyledSegment = {
  text: string;
  styles: TerminalTextStyle;
  hyperlink?: string | undefined;
};

export function squashTextNodesToSegments(
  node: TreeElement,
  inheritedStyles: TerminalTextStyle = {},
  inheritedHyperlink?: string,
  out: StyledSegment[] = [],
): StyledSegment[] {
  const mergedStyles = node.textStyles
    ? { ...inheritedStyles, ...node.textStyles }
    : inheritedStyles;

  for (const childNode of node.childNodes) {
    if (childNode === undefined) {
      continue;
    }

    if (childNode.nodeName === "#text") {
      if (childNode.nodeValue.length > 0) {
        out.push({
          text: childNode.nodeValue,
          styles: mergedStyles,
          hyperlink: inheritedHyperlink,
        });
      }
    } else if (childNode.nodeName === "ink-text" || childNode.nodeName === "ink-virtual-text") {
      squashTextNodesToSegments(childNode, mergedStyles, inheritedHyperlink, out);
    } else if (childNode.nodeName === "ink-link") {
      const href = childNode.attributes.href as string | undefined;
      squashTextNodesToSegments(childNode, mergedStyles, href || inheritedHyperlink, out);
    }
  }

  return out;
}

function squashTextNodes(node: TreeElement): string {
  let text = "";

  for (const childNode of node.childNodes) {
    if (childNode === undefined) {
      continue;
    }

    if (childNode.nodeName === "#text") {
      text += childNode.nodeValue;
    } else if (childNode.nodeName === "ink-text" || childNode.nodeName === "ink-virtual-text") {
      text += squashTextNodes(childNode);
    } else if (childNode.nodeName === "ink-link") {
      text += squashTextNodes(childNode);
    }
  }

  return text;
}

export default squashTextNodes;
