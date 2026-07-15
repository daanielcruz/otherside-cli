import { stringWidth } from "@/kernel/std/text/string-width.ts";

export interface GraphemeChunk {
  text: string;
  start: number;
  end: number;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function splitByColumnWidth(text: string, columnBudget: number): GraphemeChunk[] {
  const budget = Math.max(1, Math.floor(columnBudget));
  if (text.length === 0) return [{ text: "", start: 0, end: 0 }];
  const chunks: GraphemeChunk[] = [];
  let chunkStartIndex = 0;
  let chunkWidth = 0;
  let chunkText = "";
  for (const seg of segmenter.segment(text)) {
    const graphemeText = seg.segment;
    const graphemeWidth = stringWidth(graphemeText);
    if (chunkWidth + graphemeWidth > budget && chunkText.length > 0) {
      chunks.push({ text: chunkText, start: chunkStartIndex, end: seg.index });
      chunkStartIndex = seg.index;
      chunkText = "";
      chunkWidth = 0;
    }
    chunkText += graphemeText;
    chunkWidth += graphemeWidth;
  }
  chunks.push({ text: chunkText, start: chunkStartIndex, end: text.length });
  return chunks;
}
