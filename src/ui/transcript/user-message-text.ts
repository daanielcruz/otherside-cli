import { wrapPromptText } from "@/ui/input/prompt-text.ts";

export const USER_MESSAGE_MAX_CHARS = 10_000;
export const USER_MESSAGE_HEAD_CHARS = 2_500;
export const USER_MESSAGE_TAIL_CHARS = 2_500;
export const USER_MESSAGE_PREFIX_WIDTH = 2;
export const USER_MESSAGE_RIGHT_PADDING = 5;

/**
 * Very long pasted messages collapse to a head + tail with a hidden-line count
 * so the transcript stays scannable. Shared by both renderers.
 */
export function collapseLongUserMessage(text: string): string {
  if (text.length <= USER_MESSAGE_MAX_CHARS) return text;
  const head = text.slice(0, USER_MESSAGE_HEAD_CHARS);
  const tail = text.slice(-USER_MESSAGE_TAIL_CHARS);
  // The elided slice always spans at least one line: a newline-free giant line
  // (one pasted JSON row) still hides real content, so the partial line counts.
  const elided = text.slice(USER_MESSAGE_HEAD_CHARS, text.length - USER_MESSAGE_TAIL_CHARS);
  const hiddenLines = countCharMatches(elided, "\n", 0) + 1;
  return `${head}\n… +${hiddenLines} lines …\n${tail}`;
}

function countCharMatches(str: string, ch: string, start: number): number {
  let count = 0;
  let i = str.indexOf(ch, start);
  while (i !== -1) {
    count++;
    i = str.indexOf(ch, i + 1);
  }
  return count;
}

/** Wrap a user message body to the inner width left of the chevron gutter. */
export function userMessageLines(text: string, width: number): string[] {
  const inner = Math.max(1, width - USER_MESSAGE_PREFIX_WIDTH - USER_MESSAGE_RIGHT_PADDING);
  return wrapPromptText(text, inner);
}
