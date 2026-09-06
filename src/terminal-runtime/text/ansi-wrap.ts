import wrapAnsiNpm from "wrap-ansi";
import { ESC } from "@/terminal-runtime/terminal/ansi-control.js";
import { osc8UrlLink } from "@/terminal-runtime/terminal/hyperlink-sequences.js";
import { terminalAllowsLinks } from "@/terminal-runtime/terminal/link-policy.js";

type WrapAnsiOptions = {
  hard?: boolean;
  wordWrap?: boolean;
  trim?: boolean;
};

const wrapAnsiBun =
  typeof Bun !== "undefined" && typeof Bun.wrapAnsi === "function" ? Bun.wrapAnsi : null;
const OSC8_PREFIX = `${ESC}]8;`;

function wrapAnsi(input: string, columns: number, options?: WrapAnsiOptions): string {
  const implementation = input.includes(OSC8_PREFIX) ? wrapAnsiNpm : (wrapAnsiBun ?? wrapAnsiNpm);
  return implementation(input, columns, options);
}

/** Leading colour sequences, then the space the wrap broke on. */
const BREAK_INDENT_RE = new RegExp(`^((?:${ESC}\\[[0-9;]*m)*) +`);

/**
 * Wrap prose to a column, breaking between words and only inside a word too long to fit.
 *
 * The first row keeps whatever indentation the caller built into the text — a list
 * marker or a quote sits there and is part of the content. Every row after it is the
 * wrapper's own, so the space it chose to break on is dropped: kept, it lands at the
 * start of the row whenever the previous row filled the column exactly, and pushes that
 * one row a column further in than its neighbours.
 */
export function wrapProse(
  text: string,
  columns: number,
  options: Pick<WrapAnsiOptions, "hard"> = {},
): string[] {
  const [first = "", ...rest] = wrapAnsi(text, columns, {
    hard: options.hard ?? true,
    trim: false,
    wordWrap: true,
  }).split("\n");
  return [first, ...rest.map((row) => row.replace(BREAK_INDENT_RE, "$1"))];
}

export function wrapUrlLink(url: string, columns: number): string[] {
  const text = terminalAllowsLinks() ? osc8UrlLink({ url, label: url }) : url;
  return wrapAnsi(text, columns, { hard: true, trim: false, wordWrap: true }).split("\n");
}

export { wrapAnsi };
