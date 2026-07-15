import { diffWordsWithSpace, parsePatch, type StructuredPatchHunk } from "diff";
import { Box, colorize, type Color as InkColor, resolveColorSequence, Text } from "@/ink";
import { type GraphemeChunk, splitByColumnWidth } from "@/kernel/std/text/grapheme-width.ts";
import { stringWidth } from "@/kernel/std/text/string-width.ts";
import {
  defaultForegroundForTheme,
  resolveScope,
  type ScopeMap,
  scopesForTheme,
} from "@/ui/theme/syntax-scopes.ts";
import { Color, getActiveThemeName } from "@/ui/theme/theme.ts";
import { detectLanguage, type Span, tokenize } from "@/ui/transcript/markdown/highlight.ts";

export function dedupeKey(prefix: string, value: string, seen: Map<string, number>): string {
  const base = `${prefix}:${value}`;
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return count === 1 ? base : `${base}:${count}`;
}

export function renderDiffLines(
  fragment: string,
  width = 80,
): { key: string; element: React.JSX.Element }[] {
  const structured = renderStructuredDiff(fragment, width);
  if (structured) return structured;
  const seen = new Map<string, number>();
  return fragment.split("\n").map((row) => {
    let color: InkColor = Color.muted;
    if (row.startsWith("+") && !row.startsWith("+++")) color = Color.success;
    else if (row.startsWith("-") && !row.startsWith("---")) color = Color.error;
    else if (row.startsWith("@@")) color = Color.highlight;
    return {
      key: dedupeKey("diff", row, seen),
      element: <Text color={color}>{row}</Text>,
    };
  });
}

function padLineNo(n: number, digits: number): string {
  return String(n).padStart(digits, " ");
}

function renderStructuredDiff(
  unified: string,
  width = 80,
): { key: string; element: React.JSX.Element }[] | null {
  let parsed: ReturnType<typeof parsePatch>;
  try {
    parsed = parsePatch(unified);
  } catch {
    return null;
  }
  const hunks: StructuredPatchHunk[] = parsed.flatMap((p) => p.hunks);
  if (hunks.length === 0) return null;
  let added = 0;
  let removed = 0;
  let maxLine = 1;
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
    maxLine = Math.max(maxLine, h.oldStart + h.oldLines - 1, h.newStart + h.newLines - 1);
  }
  const digits = String(maxLine).length;
  const seen = new Map<string, number>();
  const rows: { key: string; element: React.JSX.Element }[] = [];
  rows.push({
    key: dedupeKey("diff-header", `${added}:${removed}`, seen),
    element: <Text color={Color.muted}>{diffHeaderText(added, removed)}</Text>,
  });
  for (let hi = 0; hi < hunks.length; hi += 1) {
    const h = hunks[hi];
    if (h === undefined) continue;
    if (hi > 0) {
      rows.push({
        key: dedupeKey("diff-sep", String(hi), seen),
        element: <Text color={Color.muted}>...</Text>,
      });
    }
    let oldNo = h.oldStart;
    let newNo = h.newStart;
    let i = 0;
    while (i < h.lines.length) {
      const line = h.lines[i];
      if (line === undefined) break;
      if (line.startsWith("\\")) {
        i += 1;
        continue;
      }
      const ch = line[0];
      const text = line.slice(1);
      if (ch === "-") {
        const removedLines: string[] = [];
        let j = i;
        while (j < h.lines.length) {
          const l = h.lines[j];
          if (l === undefined || !l.startsWith("-")) break;
          removedLines.push(l.slice(1));
          j += 1;
        }
        const addedLines: string[] = [];
        while (j < h.lines.length) {
          const l = h.lines[j];
          if (l === undefined || !l.startsWith("+")) break;
          addedLines.push(l.slice(1));
          j += 1;
        }
        const paired = removedLines.length === addedLines.length && removedLines.length > 0;
        for (let k = 0; k < removedLines.length; k += 1) {
          const rem = removedLines[k] ?? "";
          const add = paired ? (addedLines[k] ?? null) : null;
          rows.push({
            key: dedupeKey("diff", `-${oldNo}:${rem}`, seen),
            element: removedRow(oldNo, digits, rem, add, width),
          });
          oldNo += 1;
        }
        for (let k = 0; k < addedLines.length; k += 1) {
          const add = addedLines[k] ?? "";
          const rem = paired ? (removedLines[k] ?? null) : null;
          rows.push({
            key: dedupeKey("diff", `+${newNo}:${add}`, seen),
            element: addedRow(newNo, digits, add, rem, width),
          });
          newNo += 1;
        }
        i = j;
      } else if (ch === "+") {
        rows.push({
          key: dedupeKey("diff", `+${newNo}:${text}`, seen),
          element: addedRow(newNo, digits, text, null, width),
        });
        newNo += 1;
        i += 1;
      } else {
        const ctxLinePrefix = `${padLineNo(newNo, digits)}   `;
        const ctxContentWidth = Math.max(1, width - ctxLinePrefix.length);
        const ctxContPrefix = " ".repeat(ctxLinePrefix.length);
        const ctxChunks = splitByColumnWidth(text, ctxContentWidth);
        const ctxPhysicalRows: React.JSX.Element[] = [];
        for (let ci = 0; ci < ctxChunks.length; ci += 1) {
          const cText = ctxChunks[ci]?.text ?? "";
          const rowPfx = ci === 0 ? ctxLinePrefix : ctxContPrefix;
          ctxPhysicalRows.push(<Text key={ci} color={Color.muted}>{`${rowPfx}${cText}`}</Text>);
        }
        rows.push({
          key: dedupeKey("diff", ` ${newNo}:${text}`, seen),
          element: <Box flexDirection="column">{ctxPhysicalRows}</Box>,
        });
        oldNo += 1;
        newNo += 1;
        i += 1;
      }
    }
  }
  return rows;
}

function diffHeaderText(added: number, removed: number): string {
  if (added > 0 && removed === 0) return `Added ${added} line${added === 1 ? "" : "s"}`;
  if (removed > 0 && added === 0) return `Removed ${removed} line${removed === 1 ? "" : "s"}`;
  return `Added ${added} line${added === 1 ? "" : "s"}, removed ${removed} line${removed === 1 ? "" : "s"}`;
}

function removedRow(
  lineNo: number,
  digits: number,
  rem: string,
  paired: string | null,
  width: number,
): React.JSX.Element {
  const prefix = `${padLineNo(lineNo, digits)} - `;
  const contPrefix = `${" ".repeat(digits)} - `;
  const segments = wordSegments(paired, rem, "removed");
  return diffRow(
    prefix,
    contPrefix,
    segments,
    Color.diffRemBg,
    Color.diffRemHighlightBg,
    Color.diffRemFg,
    width,
  );
}

function addedRow(
  lineNo: number,
  digits: number,
  add: string,
  paired: string | null,
  width: number,
): React.JSX.Element {
  const prefix = `${padLineNo(lineNo, digits)} + `;
  const contPrefix = `${" ".repeat(digits)} + `;
  const segments = wordSegments(paired, add, "added");
  return diffRow(
    prefix,
    contPrefix,
    segments,
    Color.diffAddBg,
    Color.diffAddHighlightBg,
    Color.diffAddFg,
    width,
  );
}

interface DiffSegment {
  text: string;
  highlight: boolean;
}

function wordSegments(
  paired: string | null,
  current: string,
  side: "added" | "removed",
): DiffSegment[] {
  if (paired === null) return [{ text: current, highlight: false }];
  const before = side === "added" ? paired : current;
  const after = side === "added" ? current : paired;
  const parts = diffWordsWithSpace(before, after);

  // Check if we should use word-level diffing
  const CHANGE_THRESHOLD = 0.4;
  const totalLength = before.length + after.length;
  const changedLength = parts
    .filter((part) => part.added || part.removed)
    .reduce((sum, part) => sum + part.value.length, 0);
  const changeRatio = totalLength > 0 ? changedLength / totalLength : 0;

  if (changeRatio > CHANGE_THRESHOLD) {
    return [{ text: current, highlight: false }];
  }

  const segments: DiffSegment[] = [];
  for (const part of parts) {
    if (side === "added" && part.removed) continue;
    if (side === "removed" && part.added) continue;
    const highlight = side === "added" ? part.added === true : part.removed === true;
    segments.push({ text: part.value, highlight });
  }
  return segments;
}

function sliceSegments(segments: DiffSegment[], start: number, end: number): DiffSegment[] {
  const result: DiffSegment[] = [];
  let cursor = 0;
  for (const seg of segments) {
    const segEnd = cursor + seg.text.length;
    if (segEnd <= start) {
      cursor = segEnd;
      continue;
    }
    if (cursor >= end) break;
    const sliceStart = Math.max(0, start - cursor);
    const sliceEnd = Math.min(seg.text.length, end - cursor);
    result.push({
      text: seg.text.slice(sliceStart, sliceEnd),
      highlight: seg.highlight,
    });
    cursor = segEnd;
  }
  return result;
}

function diffRow(
  prefix: string,
  contPrefix: string,
  segments: DiffSegment[],
  baseBg: InkColor | undefined,
  highlightBg: InkColor | undefined,
  prefixFg: InkColor,
  width: number,
): React.JSX.Element {
  const contentWidth = Math.max(1, width - prefix.length);
  const fullText = segments.map((s) => s.text).join("");
  const physicalRows: React.JSX.Element[] = [];
  const chunks = splitByColumnWidth(fullText, contentWidth);
  for (let chunk = 0; chunk < chunks.length; chunk += 1) {
    const { start: chunkStart, end: chunkEnd } = chunks[chunk] as GraphemeChunk;
    const rowPrefix = chunk === 0 ? prefix : contPrefix;
    const rowSegments = sliceSegments(segments, chunkStart, chunkEnd);
    physicalRows.push(
      <Text key={chunk}>
        <Text color={prefixFg} backgroundColor={baseBg}>
          {rowPrefix}
        </Text>
        {rowSegments.map((seg, idx) => (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: stable per render
            key={idx}
            color={Color.diffContentFg}
            backgroundColor={seg.highlight ? highlightBg : baseBg}
          >
            {seg.text}
          </Text>
        ))}
      </Text>,
    );
  }
  return <Box flexDirection="column">{physicalRows}</Box>;
}

function paintSegment(text: string, fg: InkColor | undefined, bg: InkColor | undefined): string {
  const fgSgr = resolveColorSequence(fg, "foreground");
  const bgSgr = resolveColorSequence(bg, "background");
  return `${fgSgr.open}${bgSgr.open}${text}${bgSgr.close}${fgSgr.close}`;
}

function expandTabsInline(s: string): string {
  return s.replace(/\t/g, "    ");
}

interface DiffRowContext {
  baseBg: InkColor | undefined;
  highlightBg: InkColor | undefined;
  prefixFg: InkColor;
  contentFg: InkColor;
  language: string | null;
  scopes: ScopeMap;
  defaultFg: InkColor;
}

function buildAnsiPhysicalRow(
  rowPrefix: string,
  text: string,
  ranges: Array<{ start: number; end: number }>,
  tokenColors: (InkColor | null)[],
  ctx: DiffRowContext,
  cap: number,
): string {
  let body = paintSegment(rowPrefix, ctx.prefixFg, ctx.baseBg);
  let runStart = 0;
  let runFg: InkColor | undefined = tokenColors[0] ?? ctx.contentFg;
  let runBg: InkColor | undefined = isInRanges(0, ranges) ? ctx.highlightBg : ctx.baseBg;
  for (let i = 1; i <= text.length; i += 1) {
    const atEnd = i === text.length;
    const wantBg: InkColor | undefined = atEnd
      ? runBg
      : isInRanges(i, ranges)
        ? ctx.highlightBg
        : ctx.baseBg;
    const wantFg: InkColor | undefined = atEnd ? runFg : (tokenColors[i] ?? ctx.contentFg);
    if (atEnd || wantBg !== runBg || wantFg !== runFg) {
      body += paintSegment(text.slice(runStart, i), runFg, runBg);
      runStart = i;
      runBg = wantBg;
      runFg = wantFg;
    }
  }
  const used = stringWidth(text);
  if (used < cap) body += paintSegment(" ".repeat(cap - used), ctx.contentFg, ctx.baseBg);
  return body;
}

function fitDiffPrefix(prefix: string, marker: "-" | "+" | "", width: number): string {
  if (stringWidth(prefix) <= Math.max(0, width - 2)) return prefix;
  const compact = marker.length > 0 ? `${marker} ` : "";
  if (stringWidth(compact) <= Math.max(0, width - 2)) return compact;
  return "";
}

function buildAnsiDiffRow(
  prefix: string,
  contPrefix: string,
  segments: DiffSegment[],
  rawText: string,
  ctx: DiffRowContext,
  width: number,
  marker: "-" | "+",
): string[] {
  const expandedText = expandTabsInline(rawText);
  const expandedSegments = segments.map((s) => ({
    ...s,
    text: expandTabsInline(s.text),
  }));
  const firstPrefix = fitDiffPrefix(prefix, marker, width);
  const continuationPrefix = fitDiffPrefix(contPrefix, marker, width);
  const prefixWidth = Math.max(stringWidth(firstPrefix), stringWidth(continuationPrefix));
  const cap = Math.max(1, width - prefixWidth);
  const allTokenColors = perCharTokenFg(expandedText, ctx);
  const chunks = splitByColumnWidth(expandedText, cap);
  const physicalLines: string[] = [];
  for (let chunk = 0; chunk < chunks.length; chunk += 1) {
    const { text: chunkText, start: chunkStart, end: chunkEnd } = chunks[chunk] as GraphemeChunk;
    const chunkRanges: Array<{ start: number; end: number }> = [];
    for (const seg of expandedSegments) {
      if (!seg.highlight) continue;
      let segStart = 0;
      for (const s2 of expandedSegments) {
        if (s2 === seg) break;
        segStart += s2.text.length;
      }
      const segEnd = segStart + seg.text.length;
      const overlapStart = Math.max(segStart, chunkStart);
      const overlapEnd = Math.min(segEnd, chunkEnd);
      if (overlapStart < overlapEnd) {
        chunkRanges.push({
          start: overlapStart - chunkStart,
          end: overlapEnd - chunkStart,
        });
      }
    }
    const chunkTokenColors = allTokenColors.slice(chunkStart, chunkEnd);
    const rowPrefix = chunk === 0 ? firstPrefix : continuationPrefix;
    physicalLines.push(
      buildAnsiPhysicalRow(rowPrefix, chunkText, chunkRanges, chunkTokenColors, ctx, cap),
    );
  }
  return physicalLines;
}

function isInRanges(idx: number, ranges: Array<{ start: number; end: number }>): boolean {
  for (const r of ranges) {
    if (idx >= r.start && idx < r.end) return true;
  }
  return false;
}

function perCharTokenFg(text: string, ctx: DiffRowContext): (InkColor | null)[] {
  const out: (InkColor | null)[] = new Array(text.length).fill(null);
  if (!ctx.language) return out;
  const spans: Span[] = tokenize(text, ctx.language);
  let cursor = 0;
  for (const span of spans) {
    const len = span.text.length;
    const fg = resolveScope({
      scope: span.scope,
      text: span.text,
      scopes: ctx.scopes,
      fallback: ctx.defaultFg,
    });
    for (let i = 0; i < len && cursor + i < text.length; i += 1) {
      out[cursor + i] = fg;
    }
    cursor += len;
  }
  return out;
}

export function renderDiffAnsiLines(
  unified: string,
  width: number,
  filePath?: string,
): { headerLines: string[]; bodyLines: string[] } | null {
  let parsed: ReturnType<typeof parsePatch>;
  try {
    parsed = parsePatch(unified);
  } catch {
    return null;
  }
  const hunks: StructuredPatchHunk[] = parsed.flatMap((p) => p.hunks);
  if (hunks.length === 0) return null;
  let added = 0;
  let removed = 0;
  let maxLine = 1;
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
    maxLine = Math.max(maxLine, h.oldStart + h.oldLines - 1, h.newStart + h.newLines - 1);
  }
  const digits = String(maxLine).length;
  const headerLines = [diffHeaderText(added, removed)];
  const bodyLines: string[] = [];

  const language = filePath ? detectLanguage(filePath) : null;
  const themeName = getActiveThemeName();
  const scopes = scopesForTheme(themeName);
  const defaultFg = defaultForegroundForTheme(themeName);
  const addCtx: DiffRowContext = {
    baseBg: Color.diffAddBg,
    highlightBg: Color.diffAddHighlightBg,
    prefixFg: Color.diffAddFg,
    contentFg: Color.diffContentFg,
    language,
    scopes,
    defaultFg,
  };
  const remCtx: DiffRowContext = {
    baseBg: Color.diffRemBg,
    highlightBg: Color.diffRemHighlightBg,
    prefixFg: Color.diffRemFg,
    contentFg: Color.diffContentFg,
    language,
    scopes,
    defaultFg,
  };

  for (let hi = 0; hi < hunks.length; hi += 1) {
    const h = hunks[hi];
    if (h === undefined) continue;
    if (hi > 0) {
      // padEnd never shortens, so a raw "..." overflows a 1–2 column budget.
      const separator = width >= 3 ? "...".padEnd(width, " ") : ".".repeat(Math.max(0, width));
      bodyLines.push(colorize(separator, Color.muted, "foreground"));
    }
    let oldNo = h.oldStart;
    let newNo = h.newStart;
    let i = 0;
    while (i < h.lines.length) {
      const line = h.lines[i];
      if (line === undefined) break;
      if (line.startsWith("\\")) {
        i += 1;
        continue;
      }
      const ch = line[0];
      const text = line.slice(1);
      if (ch === "-") {
        const removedLines: string[] = [];
        let j = i;
        while (j < h.lines.length) {
          const l = h.lines[j];
          if (l === undefined || !l.startsWith("-")) break;
          removedLines.push(l.slice(1));
          j += 1;
        }
        const addedLines: string[] = [];
        while (j < h.lines.length) {
          const l = h.lines[j];
          if (l === undefined || !l.startsWith("+")) break;
          addedLines.push(l.slice(1));
          j += 1;
        }
        const paired = removedLines.length === addedLines.length && removedLines.length > 0;
        for (let k = 0; k < removedLines.length; k += 1) {
          const rem = removedLines[k] ?? "";
          const pair = paired ? (addedLines[k] ?? null) : null;
          const segments = wordSegments(pair, rem, "removed");
          const prefix = `${padLineNo(oldNo, digits)} - `;
          const contPrefix = `${" ".repeat(digits)} - `;
          bodyLines.push(
            ...buildAnsiDiffRow(prefix, contPrefix, segments, rem, remCtx, width, "-"),
          );
          oldNo += 1;
        }
        for (let k = 0; k < addedLines.length; k += 1) {
          const add = addedLines[k] ?? "";
          const pair = paired ? (removedLines[k] ?? null) : null;
          const segments = wordSegments(pair, add, "added");
          const prefix = `${padLineNo(newNo, digits)} + `;
          const contPrefix = `${" ".repeat(digits)} + `;
          bodyLines.push(
            ...buildAnsiDiffRow(prefix, contPrefix, segments, add, addCtx, width, "+"),
          );
          newNo += 1;
        }
        i = j;
      } else if (ch === "+") {
        const segments = wordSegments(null, text, "added");
        const prefix = `${padLineNo(newNo, digits)} + `;
        const contPrefix = `${" ".repeat(digits)} + `;
        bodyLines.push(...buildAnsiDiffRow(prefix, contPrefix, segments, text, addCtx, width, "+"));
        newNo += 1;
        i += 1;
      } else {
        const rawCtxPrefix = `${padLineNo(newNo, digits)}   `;
        const rawCtxContPrefix = " ".repeat(rawCtxPrefix.length);
        const ctxPrefix = fitDiffPrefix(rawCtxPrefix, "", width);
        const ctxContPrefix = fitDiffPrefix(rawCtxContPrefix, "", width);
        const ctxPrefixWidth = Math.max(stringWidth(ctxPrefix), stringWidth(ctxContPrefix));
        const ctxCap = Math.max(1, width - ctxPrefixWidth);
        const expanded = expandTabsInline(text);
        const ctxChunks = splitByColumnWidth(expanded, ctxCap);
        for (let ci = 0; ci < ctxChunks.length; ci += 1) {
          const cText = ctxChunks[ci]?.text ?? "";
          const rowPfx = ci === 0 ? ctxPrefix : ctxContPrefix;
          const tokenFg = perCharTokenFg(cText, {
            baseBg: undefined,
            highlightBg: undefined,
            prefixFg: defaultFg,
            contentFg: defaultFg,
            language,
            scopes,
            defaultFg,
          });
          let body = colorize(rowPfx, Color.muted, "foreground");
          let runStart = 0;
          let runFg: InkColor = tokenFg[0] ?? defaultFg;
          for (let p = 1; p <= cText.length; p += 1) {
            const atEnd = p === cText.length;
            const wantFg = atEnd ? runFg : (tokenFg[p] ?? defaultFg);
            if (atEnd || wantFg !== runFg) {
              body += colorize(cText.slice(runStart, p), runFg, "foreground");
              runStart = p;
              runFg = wantFg;
            }
          }
          const usedW = stringWidth(rowPfx) + stringWidth(cText);
          if (usedW < width) body += " ".repeat(width - usedW);
          bodyLines.push(body);
        }
        oldNo += 1;
        newNo += 1;
        i += 1;
      }
    }
  }
  return { headerLines, bodyLines };
}
