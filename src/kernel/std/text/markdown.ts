import { marked } from "marked";

let markedConfigured = false;

export function configureMarked(): void {
  if (markedConfigured) return;
  markedConfigured = true;
  marked.use({
    tokenizer: {
      del() {
        return undefined;
      },
    },
  });
}

export function stableMarkdownLength(source: string, prevStableLength: number): number {
  configureMarked();
  const boundary = Math.min(Math.max(0, prevStableLength), source.length);
  const tail = source.slice(boundary);
  if (tail.length === 0) return boundary;
  const tokens = marked.lexer(tail);
  let lastIdx = tokens.length - 1;
  while (lastIdx >= 0 && tokens[lastIdx]?.type === "space") lastIdx--;
  let advance = 0;
  for (let i = 0; i < lastIdx; i++) advance += tokens[i]?.raw.length ?? 0;
  return advance > 0 ? boundary + advance : boundary;
}
