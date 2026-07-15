import { useState } from "react";
import { Box, Text } from "@/ink";
import { wrapLine } from "@/kernel/std/text/wrapping.ts";
import { Color, GUTTER_CONT, GUTTER_HEAD } from "@/ui/theme/theme.ts";
import { thousandsValue, useSharedIntervalTick } from "@/ui/transcript/message-shared.ts";
import { summarizeArgs } from "@/ui/transcript/tool-render/index.tsx";
import type { SkillProgressItem } from "@/ui/transcript/types";

const MAX_SKILL_PROGRESS_ROWS = 3;
const SKILL_ELAPSED_TICK_MS = 1_000;

export function SkillRow({
  progress,
  isError,
  width,
  skillName,
  startedAt,
  completedAt,
  inputTokens,
  outputTokens,
  isActive,
}: {
  progress: SkillProgressItem[];
  isError: boolean;
  width: number;
  skillName?: string | undefined;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  isActive?: boolean | undefined;
}): React.JSX.Element | null {
  const [, setElapsedTick] = useState(0);
  useSharedIntervalTick(
    () => setElapsedTick((n) => n + 1),
    isActive === true ? SKILL_ELAPSED_TICK_MS : null,
  );
  const summary = buildSkillSummary({
    isActive,
    startedAt,
    completedAt,
    inputTokens,
    outputTokens,
  });
  if (progress.length === 0) {
    return (
      <Box>
        <Text color={isError ? Color.error : Color.muted}>{GUTTER_HEAD}</Text>
        <Text color={Color.muted}>Initializing…</Text>
      </Box>
    );
  }
  const rows = skillProgressRows(progress);
  const visible = rows.slice(-MAX_SKILL_PROGRESS_ROWS);
  const hidden = rows.length - visible.length;
  const contentWidth = Math.max(1, width - GUTTER_CONT.length);
  const flatRows = flattenSkillRows(visible, contentWidth);
  void skillName;
  return (
    <Box flexDirection="column">
      {flatRows.map((flat, flatIdx) => (
        <Box key={flat.key} flexDirection="row">
          <Text color={isError ? Color.error : Color.muted}>
            {flatIdx === 0 ? GUTTER_HEAD : GUTTER_CONT}
          </Text>
          <Text color={flat.color}>{flat.line}</Text>
        </Box>
      ))}
      {!!summary && (
        <Box flexDirection="row">
          <Text color={Color.muted}>{GUTTER_CONT}</Text>
          <Text color={Color.muted}>{summary}</Text>
        </Box>
      )}
      {hidden > 0 && (
        <Box flexDirection="row">
          <Text color={Color.muted}>{GUTTER_CONT}</Text>
          <Text color={Color.muted}>
            {`… +${hidden} more tool ${hidden === 1 ? "use" : "uses"}`}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function buildSkillSummary({
  isActive,
  startedAt,
  completedAt,
  inputTokens,
  outputTokens,
}: {
  isActive?: boolean | undefined;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}): string | null {
  if (startedAt === undefined) return null;
  const end = !isActive && completedAt !== undefined ? completedAt : Date.now();
  const elapsedMs = Math.max(0, end - startedAt);
  const elapsedText = formatSkillElapsed(elapsedMs);
  const tokenIn = inputTokens ?? 0;
  const tokenOut = outputTokens ?? 0;
  const tokenTotal = tokenIn + tokenOut;
  const tokenText = tokenTotal > 0 ? `${formatTokenCount(tokenTotal)} tok` : "0 tok";
  const lead = isActive ? "Running" : "Done";
  return `${lead} · ${elapsedText} · ${tokenText}`;
}

function formatSkillElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? `${h}h` : `${h}h${mm}m`;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (n >= 1000) {
    const k = n / 1000;
    return `${thousandsValue(k)}k`;
  }
  return `${n}`;
}

interface FlatSkillLine {
  key: string;
  line: string;
  color: (typeof Color)[keyof typeof Color];
}

function flattenSkillRows(rows: SkillProgressRow[], contentWidth: number): FlatSkillLine[] {
  const seen = new Map<string, number>();
  const out: FlatSkillLine[] = [];
  for (const row of rows) {
    const lines = wrapLine(row.text, { width: contentWidth });
    const safe = lines.length > 0 ? lines : [""];
    for (const line of safe) {
      const baseKey = `${row.text}::${line}`;
      const count = seen.get(baseKey) ?? 0;
      seen.set(baseKey, count + 1);
      out.push({ key: `skill:${baseKey}:${count}`, line, color: row.color });
    }
  }
  return out;
}

interface SkillProgressRow {
  text: string;
  color: (typeof Color)[keyof typeof Color];
}

const HIDDEN_SKILL_TOOLS = new Set(["ToolSearch"]);

function skillProgressRows(progress: SkillProgressItem[]): SkillProgressRow[] {
  const rows: SkillProgressRow[] = [];
  for (const item of progress) {
    if (item.kind === "text") {
      const trimmed = item.text.trim();
      if (trimmed.length === 0) continue;
      const firstLine = trimmed.split("\n").find((line) => line.trim().length > 0) ?? trimmed;
      rows.push({ text: firstLine.trim(), color: Color.text });
    } else {
      if (HIDDEN_SKILL_TOOLS.has(item.toolName)) continue;
      const args = summarizeArgs(item.toolName, item.args);
      const label = args ? `${item.toolName}(${args})` : item.toolName;
      const color = item.status === "error" ? Color.error : Color.text;
      rows.push({ text: label, color });
      if (item.status === "running") {
        rows.push({ text: "Running…", color: Color.muted });
      }
    }
  }
  return rows;
}
