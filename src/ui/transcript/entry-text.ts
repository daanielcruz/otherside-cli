import { formatImageRef } from "@/kernel/std/paste/ref.ts";
import { osc8FileLink } from "@/terminal-runtime/terminal/hyperlink-sequences.js";
import { terminalAllowsLinks } from "@/terminal-runtime/terminal/link-policy.js";

const REPORT_PATH_RE = /(\/\S+\.md)\b/;

export function withReportLink(text: string): string {
  if (!terminalAllowsLinks()) return text;
  return text.replace(REPORT_PATH_RE, (path) => osc8FileLink({ path, label: path }));
}

const THINKING_HEADLINE_RE = /^\*\*(.+?)\*\*[ \t]*$/gm;

/**
 * Some providers write their reasoning as bold headline paragraphs (`**Doing X**`). A
 * whole line of bold outshines the dimmed block around it and reads as assistant text
 * that leaked in, so its markers come off and the line is spoken plainly. Emphasis
 * inside a sentence is the model's own and is left to render.
 */
export function demoteThinkingHeadlines(thinking: string): string {
  return thinking.replace(THINKING_HEADLINE_RE, "$1");
}

/**
 * The chip standing in for a pasted image. The paste is written to the image cache,
 * so the chip opens it in the reader's viewer; without a cached path — or a terminal
 * that can carry links — it stays the plain reference.
 */
export function imageRefLink(id: number, localPath: string | undefined): string {
  const label = formatImageRef(id);
  if (localPath === undefined || !terminalAllowsLinks()) return label;
  return osc8FileLink({ path: localPath, label });
}
