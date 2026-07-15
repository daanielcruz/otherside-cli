import { homedir } from "node:os";
import { marked, type Token, type Tokens } from "marked";
import { memo, type ReactNode, useRef } from "react";
import { AnsiText, Box, colorize, renderTextWithStyles, Text, type TextStyles } from "@/ink";
import { stripAnsi } from "@/kernel/std/ansi.ts";
import { Color, Glyph, getActiveThemeName, type ThemeName } from "@/ui/theme/theme.ts";
import { tokenize } from "@/ui/transcript/markdown/highlight.ts";
import { osc8FileLink, osc8UrlLink } from "@/ui/transcript/markdown/osc8.ts";
import { supportsHyperlinks } from "@/ui/transcript/tool-render/args.ts";
import { MarkdownTable } from "./table.tsx";

const EOL = "\n";
const STRIPPED_TAGS_RE =
  /<(commit_analysis|context|function_analysis|pr_analysis)>[\s\S]*?<\/\1>\n?/g;

const TOKEN_CACHE_MAX = 500;
const tokenCache = new Map<string, Token[]>();
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /;

export { stableMarkdownLength } from "@/kernel/std/text/markdown.ts";

import { configureMarked, stableMarkdownLength } from "@/kernel/std/text/markdown.ts";

export function stripPromptXmlTags(content: string): string {
  return content.replace(STRIPPED_TAGS_RE, "").trim();
}

export interface MarkdownProps {
  source: string;
  dim?: boolean;
  forceWidth?: number;
  tailWrap?: "wrap-stream" | undefined;
}

interface MarkdownElementsInput {
  source: string;
  dim: boolean | undefined;
  forceWidth: number | undefined;
  tailWrap: "wrap-stream" | undefined;
}

interface MarkdownElementsCache extends MarkdownElementsInput {
  themeName: ThemeName;
  elements: ReactNode[];
}

function MarkdownImpl({ source, dim, forceWidth, tailWrap }: MarkdownProps): React.JSX.Element {
  configureMarked();
  const themeName = getActiveThemeName();
  const cacheRef = useRef<MarkdownElementsCache | null>(null);
  let cache = cacheRef.current;
  if (
    cache === null ||
    cache.source !== source ||
    cache.dim !== dim ||
    cache.forceWidth !== forceWidth ||
    cache.tailWrap !== tailWrap ||
    cache.themeName !== themeName
  ) {
    cache = {
      source,
      dim,
      forceWidth,
      tailWrap,
      themeName,
      elements: markdownElements({ source, dim, forceWidth, tailWrap }),
    };
    cacheRef.current = cache;
  }
  if (cache.elements.length === 0) return <Text> </Text>;
  return (
    <Box flexDirection="column" gap={1}>
      {cache.elements}
    </Box>
  );
}

function markdownElements({
  source,
  dim,
  forceWidth,
  tailWrap,
}: MarkdownElementsInput): ReactNode[] {
  const stripped = stripPromptXmlTags(source);
  const tokens = cachedLexer(stripped);
  const elements: ReactNode[] = [];
  let nonTableContent = "";
  // Only the LAST flushed run carries tailWrap: intermediate runs end at a
  // block boundary (complete lines), so the streaming hold-back never applies.
  const flushNonTableContent = (wrap?: "wrap-stream") => {
    if (nonTableContent.length === 0) return;
    const body = nonTableContent.trim();
    if (body.length > 0) {
      elements.push(
        <AnsiText key={elements.length} dimColor={!!dim} wrap={wrap}>
          {body}
        </AnsiText>,
      );
    }
    nonTableContent = "";
  };

  for (const token of tokens) {
    if (token.type === "table") {
      flushNonTableContent();
      elements.push(
        <MarkdownTable
          key={elements.length}
          token={token as Tokens.Table}
          formatCellTokens={formatCellTokens}
          forceWidth={forceWidth}
        />,
      );
    } else {
      nonTableContent += formatToken({
        token,
        listDepth: 0,
        orderedListNumber: null,
        parent: null,
      });
    }
  }
  flushNonTableContent(tailWrap);
  return elements;
}

export const Markdown = memo(MarkdownImpl);

export interface StreamingMarkdownProps {
  source: string;
  width?: number;
}

interface StreamingSplit {
  source: string;
  stable: string;
  unstable: string;
}

interface StreamingSplitInput {
  source: string;
  stableRef: { current: string };
}

// INVARIANT: the live streaming row must stay short enough that its top edge
// never crosses above the fold. Content above the fold that changes (a table
// recomputing column widths as rows arrive, a re-wrapped paragraph) forces a
// full terminal reset, which destroys the user's scroll position. Committed
// content leaves the live row on the next flush, so clamping here only hides
// tail lines for a moment — every line lands complete when its chunk commits.
// Budget is in SCREEN rows: a long table/code source line wraps to several.
// Kept well under the smallest common viewport (with margin for the row's own
// chrome: marginTop, stable/unstable gap, gutter prefix) so the live row's top
// edge stays below the fold even on short terminals.
const LIVE_MAX_SCREEN_ROWS = 8;
const FALLBACK_STREAM_WIDTH = 80;

function tailWithinRowBudget(
  lines: readonly string[],
  width: number,
): { tail: string[]; clamped: boolean } {
  const cols = Math.max(20, width);
  let rows = 0;
  let start = lines.length;
  while (start > 0) {
    const line = lines[start - 1] ?? "";
    rows += Math.max(1, Math.ceil(line.length / cols));
    if (rows > LIVE_MAX_SCREEN_ROWS) break;
    start -= 1;
  }
  if (start === 0) return { tail: [...lines], clamped: false };
  if (start === lines.length) {
    // A single source line can exceed the whole budget (long paragraph before
    // its first newline): keep the trailing slice instead of going blank.
    const last = lines[lines.length - 1] ?? "";
    return { tail: [last.slice(-(cols * LIVE_MAX_SCREEN_ROWS))], clamped: true };
  }
  return { tail: lines.slice(start), clamped: true };
}

// A pipe-row in the unstable region means a table is still streaming: its
// column widths recompute on every new row, mutating the TOP of the live row.
const OPEN_TABLE_ROW_RE = /^\s*\|.*\|\s*$/m;

export function StreamingMarkdown({ source, width }: StreamingMarkdownProps): React.JSX.Element {
  configureMarked();
  const stableRef = useRef("");
  const splitRef = useRef<StreamingSplit | null>(null);
  let split = splitRef.current;
  if (split === null || split.source !== source) {
    split = splitAtLastOpenBlock({ source, stableRef });
    splitRef.current = split;
  }

  const sourceLines = split.source.split("\n");
  const { tail, clamped } = tailWithinRowBudget(sourceLines, width ?? FALLBACK_STREAM_WIDTH);
  if (clamped) {
    // Over budget: render the raw tail as PLAIN TEXT — never through marked,
    // so no table/code layout can inflate the height or recompute widths.
    return (
      <Box flexDirection="column">
        <Text dim>{tail.join("\n")}</Text>
      </Box>
    );
  }

  // A table that is still open streams as plain text too (only its rows churn,
  // appending at the bottom); it paints as a real table when the block closes
  // and the chunk commits to the settled transcript.
  const unstableIsOpenTable = OPEN_TABLE_ROW_RE.test(split.unstable);
  const visibleUnstable = visibleStreamingWords(split.unstable);
  return (
    <Box flexDirection="column" gap={1}>
      {split.stable.length > 0 && <Markdown source={split.stable} />}
      {split.unstable.length > 0 &&
        (unstableIsOpenTable ? (
          <Text dim>{split.unstable.trimEnd()}</Text>
        ) : (
          visibleUnstable.length > 0 && <Markdown source={visibleUnstable} />
        ))}
    </Box>
  );
}

function visibleStreamingWords(source: string): string {
  if (source.length === 0 || /\s$/.test(source)) return source;
  for (let i = source.length - 1; i >= 0; i--) {
    if (/\s/.test(source[i] ?? "")) return source.slice(0, i + 1);
  }
  return "";
}

function splitAtLastOpenBlock({ source, stableRef }: StreamingSplitInput): StreamingSplit {
  // Strip tags + leading newlines ONLY: the trailing newline must survive —
  // it tells the word-boundary hold that the last line arrived whole.
  const stripped = source.replace(STRIPPED_TAGS_RE, "").replace(/^\n+/, "");
  if (!stripped.startsWith(stableRef.current)) {
    stableRef.current = "";
  }
  const boundary = stableRef.current.length;
  const newLength = stableMarkdownLength(stripped, boundary);
  stableRef.current = stripped.slice(0, newLength);
  const stable = stableRef.current;
  return { source, stable, unstable: stripped.slice(stable.length) };
}

function hasMarkdownSyntax(s: string): boolean {
  return MD_SYNTAX_RE.test(s.length > 500 ? s.slice(0, 500) : s);
}

function cachedLexer(content: string): Token[] {
  if (!hasMarkdownSyntax(content)) {
    return [
      {
        type: "paragraph",
        raw: content,
        text: content,
        tokens: [{ type: "text", raw: content, text: content }],
      } as Token,
    ];
  }
  const key =
    content.length < 4096
      ? content
      : `${content.length}:${content.slice(0, 64)}:${content.slice(-64)}`;
  const hit = tokenCache.get(key);
  if (hit) {
    tokenCache.delete(key);
    tokenCache.set(key, hit);
    return hit;
  }
  const tokens = marked.lexer(content);
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    const first = tokenCache.keys().next().value;
    if (first !== undefined) tokenCache.delete(first);
  }
  tokenCache.set(key, tokens);
  return tokens;
}

function formatToken(args: {
  token: Token;
  listDepth: number;
  orderedListNumber: number | null;
  parent: Token | null;
}): string {
  const { token, listDepth, orderedListNumber, parent } = args;
  switch (token.type) {
    case "blockquote": {
      const subTokens = (token as Tokens.Blockquote).tokens ?? [];
      const inner = subTokens
        .map((t) => formatToken({ token: t, listDepth: 0, orderedListNumber: null, parent: null }))
        .join("");
      const bar = renderTextWithStyles(Glyph.blockQuarter, { dim: true });
      return inner
        .split(EOL)
        .map((line) =>
          stripAnsi(line).trim().length > 0
            ? `${bar} ${renderTextWithStyles(line, { italic: true })}`
            : line,
        )
        .join(EOL);
    }
    case "code": {
      const code = token as Tokens.Code;
      return highlightCode(code.text, code.lang) + EOL;
    }
    case "codespan": {
      return colorize((token as Tokens.Codespan).text, Color.inlineCode, "foreground");
    }
    case "em": {
      const subTokens = (token as Tokens.Em).tokens ?? [];
      return renderTextWithStyles(
        subTokens
          .map((t) => formatToken({ token: t, listDepth: 0, orderedListNumber: null, parent }))
          .join(""),
        { italic: true },
      );
    }
    case "strong": {
      const subTokens = (token as Tokens.Strong).tokens ?? [];
      return renderTextWithStyles(
        subTokens
          .map((t) => formatToken({ token: t, listDepth: 0, orderedListNumber: null, parent }))
          .join(""),
        { bold: true },
      );
    }
    case "heading": {
      const heading = token as Tokens.Heading;
      const inner = (heading.tokens ?? [])
        .map((t) => formatToken({ token: t, listDepth: 0, orderedListNumber: null, parent: null }))
        .join("");
      if (heading.depth === 1) {
        return (
          renderTextWithStyles(inner, { bold: true, italic: true, underline: true }) + EOL + EOL
        );
      }
      return renderTextWithStyles(inner, { bold: true }) + EOL + EOL;
    }
    case "hr":
      return "---";
    case "image":
      return (token as Tokens.Image).href;
    case "link": {
      const link = token as Tokens.Link;
      if (link.href.startsWith("mailto:")) return link.href.replace(/^mailto:/, "");
      const linkText = (link.tokens ?? [])
        .map((t) => formatToken({ token: t, listDepth: 0, orderedListNumber: null, parent: link }))
        .join("");
      const display = stripAnsi(linkText);
      const target = display.length > 0 && display !== link.href ? linkText : link.href;
      return hyperlink(link.href, target);
    }
    case "list": {
      const list = token as Tokens.List;
      return list.items
        .map((item, idx) =>
          formatToken({
            token: item,
            listDepth,
            orderedListNumber: list.ordered ? Number(list.start) + idx : null,
            parent: list,
          }),
        )
        .join("");
    }
    case "list_item": {
      const li = token as Tokens.ListItem;
      return (li.tokens ?? [])
        .map(
          (t) =>
            `${"  ".repeat(listDepth)}${formatToken({ token: t, listDepth: listDepth + 1, orderedListNumber, parent: li })}`,
        )
        .join("");
    }
    case "paragraph": {
      const para = token as Tokens.Paragraph;
      return (
        (para.tokens ?? [])
          .map((t) =>
            formatToken({ token: t, listDepth: 0, orderedListNumber: null, parent: null }),
          )
          .join("") + EOL
      );
    }
    case "space":
      return EOL;
    case "br":
      return EOL;
    case "text": {
      const txt = token as Tokens.Text;
      if (parent?.type === "link") return txt.text;
      if (parent?.type === "list_item") {
        const bullet =
          orderedListNumber === null ? "-" : `${getListNumber(listDepth, orderedListNumber)}.`;
        const inner = (txt.tokens ?? []).length
          ? (txt.tokens ?? [])
              .map((t) => formatToken({ token: t, listDepth, orderedListNumber, parent: txt }))
              .join("")
          : txt.text;
        return `${bullet} ${inner}${EOL}`;
      }
      return (txt.tokens ?? []).length
        ? (txt.tokens ?? [])
            .map((t) =>
              formatToken({ token: t, listDepth: 0, orderedListNumber: null, parent: txt }),
            )
            .join("")
        : txt.text;
    }
    case "escape":
      return (token as Tokens.Escape).text;
    case "def":
    case "del":
    case "html":
      return "";
    default:
      return "";
  }
}

function formatCellTokens(tokens: Token[] | undefined): string {
  return (
    tokens
      ?.map((t) => formatToken({ token: t, listDepth: 0, orderedListNumber: null, parent: null }))
      .join("") ?? ""
  );
}

function getListNumber(listDepth: number, n: number): string {
  if (listDepth <= 1) return String(n);
  if (listDepth === 2) return numberToLetter(n);
  if (listDepth === 3) return numberToRoman(n);
  return String(n);
}

function numberToLetter(n: number): string {
  let result = "";
  while (n > 0) {
    n--;
    result = String.fromCharCode(97 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

const ROMAN_VALUES: ReadonlyArray<[number, string]> = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

function numberToRoman(n: number): string {
  let result = "";
  for (const [value, numeral] of ROMAN_VALUES) {
    while (n >= value) {
      result += numeral;
      n -= value;
    }
  }
  return result;
}

// Scope → style map (HLJS_COLOR_MAP):
// unlisted scopes render unstyled. ANSI names are wire facts, kept verbatim.
const SCOPE_STYLES: Record<string, TextStyles> = {
  keyword: { color: Color.syntaxKeyword },
  built_in: { color: Color.syntaxType },
  type: { color: Color.syntaxType, dim: true },
  literal: { color: Color.syntaxKeyword },
  number: { color: Color.syntaxNumber },
  regexp: { color: Color.syntaxString },
  string: { color: Color.syntaxString },
  class: { color: Color.syntaxKeyword },
  function: { color: Color.syntaxTitle },
  comment: { color: Color.syntaxNumber },
  doctag: { color: Color.syntaxNumber },
  meta: { color: "ansi:blackBright" },
  tag: { color: "ansi:blackBright" },
  name: { color: Color.syntaxKeyword },
  attr: { color: Color.syntaxType },
  emphasis: { italic: true },
  strong: { bold: true },
  link: { underline: true },
  addition: { color: Color.syntaxNumber },
  deletion: { color: Color.syntaxString },
};

function scopeToStyles(scope: string | undefined): TextStyles | null {
  if (!scope) return null;
  const head = scope.split(".")[0];
  return (head && SCOPE_STYLES[head]) || null;
}

function highlightCode(text: string, lang: string | undefined): string {
  const language = lang && lang.length > 0 ? lang.toLowerCase() : null;
  if (!language) return text;
  const spans = tokenize(text, language);
  if (spans.length <= 1 && !spans[0]?.scope) return text;
  return spans
    .map((s) => {
      const styles = scopeToStyles(s.scope);
      return styles ? renderTextWithStyles(s.text, styles) : s.text;
    })
    .join("");
}

// Link styling behavior: without OSC 8 support the URL stays visible (`label (url)` unless the label is the URL); with support the label is painted basic ANSI blue because wrap-ansi preserves basic colors across line breaks where RGB and OSC 8 combinations get dropped.
function hyperlink(url: string, label: string): string {
  if (!supportsHyperlinks() || process.env.FORCE_HYPERLINK === "0" || process.env.NO_HYPERLINK) {
    const plain = stripAnsi(label);
    if (plain !== url && url !== `http://${plain}` && url !== `https://${plain}`) {
      return `${label} (${url})`;
    }
    return url;
  }
  const localPath = url.startsWith("~/")
    ? `${homedir()}/${url.slice(2)}`
    : url.startsWith("/")
      ? url
      : null;
  const linked = localPath ? osc8FileLink({ path: localPath, label }) : osc8UrlLink({ url, label });
  return renderTextWithStyles(linked, { color: "ansi:blueBright" });
}
