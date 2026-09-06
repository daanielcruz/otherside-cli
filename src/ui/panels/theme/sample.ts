import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { isSyntaxHighlightingEnabled } from "@/ui/theme/syntax-highlighting.ts";
import { scopeSchemeName } from "@/ui/theme/syntax-scopes.ts";
import { Color, Glyph, getActiveThemeName } from "@/ui/theme/theme.ts";
import { renderDiffAnsiLines } from "@/ui/transcript/tool-render/diff.ts";

/**
 * The worked example under the theme list: a small diff drawn in the palette the
 * cursor is on, so the reader sees code, diff tints and syntax colours together
 * before choosing.
 *
 * It goes through the transcript's own diff renderer rather than painting rows
 * here, which is what makes it a preview rather than a picture of one — whatever
 * a real diff looks like, this looks like too.
 */

/** Named only so the sample resolves a language; the path is never drawn. */
const SAMPLE_PATH = "greet.ts";

const SAMPLE_PATCH = [
  `--- a/${SAMPLE_PATH}`,
  `+++ b/${SAMPLE_PATH}`,
  "@@ -1,3 +1,3 @@",
  " function greet() {",
  '-  console.log("Hello, world!");',
  '+  console.log("Hello, otherside!");',
  " }",
  "",
].join("\n");

/** Columns the sample sits in from the panel's content edge, clear of the rules. */
const SAMPLE_INDENT = " ";

export function themeSampleLines(contentWidth: number): string[] {
  const width = Math.max(1, Math.floor(contentWidth));
  const rule = renderTextWithStyles(Glyph.boxHLineDashed.repeat(width), { color: Color.border });
  const diff = renderDiffAnsiLines(
    SAMPLE_PATCH,
    Math.max(1, width - SAMPLE_INDENT.length),
    SAMPLE_PATH,
  );
  const rows = (diff?.bodyLines ?? []).map((line) => SAMPLE_INDENT + line);
  return ["", rule, ...rows, rule, SAMPLE_INDENT + syntaxStatusLine()];
}

/**
 * Names the scheme the code above is coloured with, and what the toggle does next.
 * With colouring off there is no scheme to name, so it says that instead.
 */
function syntaxStatusLine(): string {
  const text = isSyntaxHighlightingEnabled()
    ? `Syntax theme: ${scopeSchemeName(getActiveThemeName())} (ctrl+t to disable)`
    : "Syntax highlighting disabled (ctrl+t to enable)";
  return renderTextWithStyles(text, { color: Color.muted });
}
