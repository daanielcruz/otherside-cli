import {
  buildAgentSummary,
  buildBashSummary,
  buildWorkflowSummary,
  type TaskNotificationStatus,
} from "@/engine/background/tasks/notification.ts";
import {
  INTERRUPTED_FEEDBACK,
  isInterruptionMessage,
} from "@/engine/queue/runtime/interruption-text.ts";
import type { SkillProgressItem } from "@/engine/session/record/types.ts";
import { getDisplayPath } from "@/kernel/std/fs/paths.ts";
import { wrapProse } from "@/terminal-runtime/text/ansi-wrap.js";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { Color, Glyph, GUTTER_CONT, GUTTER_HEAD } from "@/ui/theme/theme.ts";
import { formatDurationMs } from "@/ui/transcript/agent-chip-data.ts";
import {
  demoteThinkingHeadlines,
  imageRefLink,
  withReportLink,
} from "@/ui/transcript/entry-text.ts";
import { renderMarkdownLines } from "@/ui/transcript/markdown/string-view-markdown.ts";
import { colorFor, prefixFor } from "@/ui/transcript/message-presentation.ts";
import {
  EXPAND_OUTPUT_HINT,
  foldOutputRows,
  type TranscriptPresentation,
  wrapOutputRows,
} from "@/ui/transcript/presentation.ts";
import type { SettledEntry } from "@/ui/transcript/settled-entry.ts";
import { RATE_LIMIT_PATTERN } from "@/ui/transcript/stream/retry.ts";
import { formatToolLines, formatToolPayloadLines } from "@/ui/transcript/string-view-tool.ts";
import {
  bashHeaderCommand,
  displayNameFor,
  resolveArgBody,
  resolveArgSegments,
} from "@/ui/transcript/tool-render/args.ts";
import { collapseLongUserMessage, userMessageLines } from "@/ui/transcript/user-message-text.ts";

const ASSISTANT_GUTTER = `${Glyph.bullet} `;
const ASSISTANT_GUTTER_WIDTH = 2;
const COMPACT_API_ERROR_CHARS = 1_000;
const HIDDEN_SKILL_TOOLS = new Set(["ToolSearch"]);

/** Lay out a run of settled entries, each opening its own block unless it hugs the last. */
export function renderSettledEntries(
  width: number,
  entries: readonly SettledEntry[],
  presentation: TranscriptPresentation,
): string[] {
  const columns = Math.max(1, width);
  const lines: string[] = [];
  for (const entry of entries) {
    // A detail-only entry (replayed reasoning) exists for the explicit
    // detailed reader; the prompt-screen document never carries it.
    if (entry.kind === "thinking" && entry.detailOnly === true && presentation !== "detailed") {
      continue;
    }
    if (!attachesToPreviousBlock(entry)) lines.push("");
    lines.push(...entryLines(entry, columns, presentation));
  }
  return lines;
}

// The interruption feedback is a gutter continuation of the block it cut short,
// and a command's output is a gutter continuation of the command echo above it —
// both hug their block instead of opening one of their own.
function attachesToPreviousBlock(entry: SettledEntry): boolean {
  if (entry.kind === "command_output") return true;
  return entry.kind === "system" && isInterruptionMessage(entry.text);
}

export function entryLines(
  entry: SettledEntry,
  width: number,
  presentation: TranscriptPresentation = "compact",
): string[] {
  switch (entry.kind) {
    case "user":
      return userEntryLines(entry, width, presentation);
    case "assistant":
      return assistantEntryLines(entry, width);
    case "tool":
      return formatToolLines(entry.data, width, presentation);
    case "thinking":
      return thinkingEntryLines(entry.text, width);
    case "system":
      return systemEntryLines(entry, width, presentation);
    case "api_error":
      return errorEntryLines(entry.text, width, "  !  ", presentation);
    case "bash_input":
      return bashInputEntryLines(entry, width, presentation);
    case "slash_error":
      return plainEntryLines(entry.text, width, `${Glyph.bullet} `, Color.warning, Color.warning);
    case "retry":
      return retryEntryLines(entry, width);
    case "command_output":
      return plainEntryLines(entry.text, width, GUTTER_HEAD, Color.muted, Color.muted);
    case "quota_gutter":
      return plainEntryLines(entry.text, width, GUTTER_HEAD, Color.error, Color.error);
    case "ask_answer":
      return askAnswerEntryLines(entry, width);
    case "task_notice":
      return taskNoticeEntryLines(entry, width);
    case "skill":
      return skillEntryLines(entry, width, presentation);
    case "compaction":
      return compactionEntryLines(entry, width);
    case "compact_done":
      return plainEntryLines(
        entry.text,
        width,
        prefixFor("compact_done"),
        colorFor("compact_done"),
        Color.muted,
      );
  }
}

function thinkingEntryLines(text: string, width: number): string[] {
  const prefix = `${Glyph.therefore} `;
  const bodyWidth = Math.max(1, width - stringWidth(prefix));
  // Reasoning is written as markdown and is read as markdown: emphasis, code spans and
  // lists carry structure the model meant, and flattening the block into one dim
  // paragraph throws that away. Only the marker is italic; the body keeps its own
  // styling under the dimming, which is applied per row because the wrap reopens a
  // colour on each row it produces but never a dim.
  const body = renderMarkdownLines(demoteThinkingHeadlines(text.trim()), bodyWidth).map((line) =>
    renderTextWithStyles(line, { dim: true }),
  );
  return prefixBodyRows(prefix, { italic: true, dim: true }, body.length > 0 ? body : [""]);
}

function systemEntryLines(
  entry: Extract<SettledEntry, { kind: "system" }>,
  width: number,
  presentation: TranscriptPresentation,
): string[] {
  if (isInterruptionMessage(entry.text)) {
    const bodyWidth = Math.max(1, width - stringWidth(GUTTER_HEAD));
    const body = wrapOutputRows(INTERRUPTED_FEEDBACK, bodyWidth).map((line) =>
      renderTextWithStyles(line, { color: Color.muted, dim: true }),
    );
    return prefixBodyRows(GUTTER_HEAD, { color: Color.muted, dim: true }, body);
  }
  if (entry.isError) {
    return errorEntryLines(entry.text, width, `${Glyph.bullet} `, presentation);
  }
  return plainEntryLines(entry.text, width, Glyph.systemBullet, Color.system, Color.system);
}

function errorEntryLines(
  text: string,
  width: number,
  prefix: string,
  presentation: TranscriptPresentation,
): string[] {
  const trimmed = text.trim();
  const truncated = presentation === "compact" && trimmed.length > COMPACT_API_ERROR_CHARS;
  const body = truncated ? `${trimmed.slice(0, COMPACT_API_ERROR_CHARS)}…` : trimmed;
  const rows = plainEntryLines(body, width, prefix, Color.error, Color.error);
  if (truncated) {
    rows.push(
      ...plainEntryLines(
        EXPAND_OUTPUT_HINT,
        width,
        " ".repeat(stringWidth(prefix)),
        Color.muted,
        Color.muted,
      ),
    );
  }
  return rows;
}

// The compaction mark always carries its restored-file list: it is the receipt of
// what survived the compact, not foldable tool output.
function compactionEntryLines(
  entry: Extract<SettledEntry, { kind: "compaction" }>,
  width: number,
): string[] {
  const color = entry.isError ? Color.error : colorFor("compaction");
  const rows = plainEntryLines(entry.text, width, prefixFor("compaction"), color, color);
  for (let index = 0; index < entry.filesRead.length; index++) {
    const file = entry.filesRead[index];
    if (!file) continue;
    const lineLabel = file.numLines === 1 ? "line" : "lines";
    rows.push(
      ...plainEntryLines(
        `Read ${getDisplayPath(file.path)} (${file.numLines} ${lineLabel})`,
        width,
        index === 0 ? GUTTER_HEAD : GUTTER_CONT,
        Color.muted,
        Color.muted,
      ),
    );
  }
  return rows;
}

function bashInputEntryLines(
  entry: Extract<SettledEntry, { kind: "bash_input" }>,
  width: number,
  presentation: TranscriptPresentation,
): string[] {
  const prefix = renderTextWithStyles("! ", {
    color: Color.bashMode,
    backgroundColor: Color.bashInputBg,
  });
  const bodyWidth = Math.max(1, width - 2);
  const commandRows = wrapOutputRows(entry.text, bodyWidth);
  const command = (commandRows.length > 0 ? commandRows : [""]).map((line, index) => {
    const body = renderTextWithStyles(line, {
      color: Color.titleStrong,
      backgroundColor: Color.bashInputBg,
    });
    return `${index === 0 ? prefix : "  "}${body}`;
  });
  return [...command, ...formatToolPayloadLines(entry.payload, entry.status, width, presentation)];
}

function retryEntryLines(entry: Extract<SettledEntry, { kind: "retry" }>, width: number): string[] {
  const metadata = parseRetryMetadata(entry.input);
  const elapsedSeconds =
    metadata.startedAt > 0 ? Math.floor((Date.now() - metadata.startedAt) / 1_000) : 0;
  const remainingSeconds = Math.max(0, metadata.seconds - elapsedSeconds);
  const headline = RATE_LIMIT_PATTERN.test(entry.text) ? "Rate limited" : entry.text.slice(0, 200);
  const detail =
    remainingSeconds > 0
      ? `Retrying in ${remainingSeconds}s · attempt ${metadata.attempt}/${metadata.maxAttempts}`
      : `Retrying · attempt ${metadata.attempt}/${metadata.maxAttempts}`;
  return [
    ...plainEntryLines(headline, width, GUTTER_HEAD, Color.error, Color.error),
    ...plainEntryLines(detail, width, GUTTER_CONT, Color.muted, Color.muted),
  ];
}

function parseRetryMetadata(input: string | undefined): {
  attempt: number;
  maxAttempts: number;
  seconds: number;
  startedAt: number;
} {
  if (input === undefined) return { attempt: 0, maxAttempts: 0, seconds: 0, startedAt: 0 };
  try {
    const parsed: unknown = JSON.parse(input);
    if (!isRecord(parsed)) return { attempt: 0, maxAttempts: 0, seconds: 0, startedAt: 0 };
    return {
      attempt: typeof parsed.attempt === "number" ? parsed.attempt : 0,
      maxAttempts: typeof parsed.maxAttempts === "number" ? parsed.maxAttempts : 0,
      seconds: typeof parsed.seconds === "number" ? parsed.seconds : 0,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
    };
  } catch {
    return { attempt: 0, maxAttempts: 0, seconds: 0, startedAt: 0 };
  }
}

function askAnswerEntryLines(
  entry: Extract<SettledEntry, { kind: "ask_answer" }>,
  width: number,
): string[] {
  if (!entry.payload || entry.payload.declined) {
    const label = entry.payload ? "User declined to answer questions" : entry.text;
    return plainEntryLines(label, width, `${Glyph.bullet} `, Color.text, Color.text);
  }

  const rows = plainEntryLines(
    "User answered Otherside's questions:",
    width,
    `${Glyph.bullet} `,
    Color.text,
    Color.text,
  );
  const branch = `  ${Glyph.boxSharpBottomLeft} `;
  const continuation = " ".repeat(stringWidth(branch));
  entry.payload.answers.forEach(({ question, answer }, index) => {
    rows.push(
      ...plainEntryLines(
        `· ${question} → ${answer}`,
        width,
        index === 0 ? branch : continuation,
        Color.muted,
        Color.muted,
      ),
    );
  });
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface TaskNoticeData {
  taskKind: "agent" | "shell" | "workflow";
  status: TaskNotificationStatus;
  description: string;
  durationMs: number;
  exitCode?: number;
  error?: string;
  taskId?: string;
}

function taskNoticeEntryLines(
  entry: Extract<SettledEntry, { kind: "task_notice" }>,
  width: number,
): string[] {
  const notice = parseTaskNotice(entry.text);
  if (!notice) {
    const color = entry.isError
      ? Color.error
      : /was stopped/.test(entry.text)
        ? Color.warning
        : /failed/.test(entry.text)
          ? Color.error
          : Color.success;
    return plainEntryLines(entry.text, width, `${Glyph.bullet} `, color, Color.text);
  }

  const options = notice.error ? { error: notice.error } : {};
  let text =
    notice.taskKind === "shell"
      ? buildBashSummary(
          notice.description,
          notice.status,
          notice.exitCode !== undefined ? { exitCode: notice.exitCode } : {},
        )
      : notice.taskKind === "workflow"
        ? buildWorkflowSummary(notice.description, notice.status, options)
        : buildAgentSummary(notice.description, notice.status, options);
  if (notice.taskKind !== "shell" && notice.durationMs > 0) {
    text += ` · ${formatDurationMs(notice.durationMs)}`;
  }
  if (notice.status === "killed" && notice.taskId) text += ` #${notice.taskId}`;
  const color =
    notice.status === "completed"
      ? Color.success
      : notice.status === "failed"
        ? Color.error
        : Color.warning;
  return plainEntryLines(text, width, `${Glyph.bullet} `, color, Color.text);
}

function parseTaskNotice(text: string): TaskNoticeData | null {
  if (!text.trimStart().startsWith("{")) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const taskKind =
    record.taskKind === "shell" ? "shell" : record.taskKind === "workflow" ? "workflow" : "agent";
  const status =
    record.status === "failed" ? "failed" : record.status === "killed" ? "killed" : "completed";
  return {
    taskKind,
    status,
    description: typeof record.description === "string" ? record.description : "",
    durationMs: typeof record.durationMs === "number" ? record.durationMs : 0,
    ...(typeof record.exitCode === "number" ? { exitCode: record.exitCode } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(typeof record.taskId === "string" ? { taskId: record.taskId } : {}),
  };
}

function skillEntryLines(
  entry: Extract<SettledEntry, { kind: "skill" }>,
  width: number,
  presentation: TranscriptPresentation,
): string[] {
  const progress = entry.progress ?? [];
  if (progress.length === 0) {
    if (entry.text.length > 0) {
      return plainEntryLines(
        withReportLink(entry.text),
        width,
        `${Glyph.bullet} `,
        entry.isError ? Color.error : Color.assistant,
        Color.text,
      );
    }
    return plainEntryLines("Initializing…", width, GUTTER_HEAD, Color.muted, Color.muted);
  }

  const bodyWidth = Math.max(1, width - stringWidth(GUTTER_CONT));
  const rows = progress.flatMap((item) => skillProgressRows(item, bodyWidth, presentation));
  const folded = foldOutputRows(rows, {
    expanded: presentation === "detailed",
    edge: "end",
  });
  const output = folded.visible.map((row, index) => {
    const gutter = index === 0 ? GUTTER_HEAD : GUTTER_CONT;
    return renderTextWithStyles(gutter, { color: entry.isError ? Color.error : Color.muted }) + row;
  });
  if (folded.hidden > 0) {
    const plural = folded.hidden === 1 ? "use" : "uses";
    output.push(
      renderTextWithStyles(GUTTER_CONT, { color: Color.muted }) +
        renderTextWithStyles(`… +${folded.hidden} more tool ${plural} ${EXPAND_OUTPUT_HINT}`, {
          color: Color.muted,
        }),
    );
  }
  return output;
}

function skillProgressRows(
  item: SkillProgressItem,
  width: number,
  presentation: TranscriptPresentation,
): string[] {
  if (item.kind === "text") {
    const first = item.text
      .trim()
      .split("\n")
      .find((line) => line.trim().length > 0);
    return first
      ? wrapOutputRows(renderTextWithStyles(first.trim(), { color: Color.text }), width)
      : [];
  }
  if (HIDDEN_SKILL_TOOLS.has(item.toolName) || displayNameFor(item.toolName, item.args) === "") {
    return [];
  }
  const segments = resolveArgSegments(undefined, item.toolName, item.args);
  const bashCommand =
    item.toolName === "Bash"
      ? bashHeaderCommand(item.args, { full: presentation !== "compact" })
      : null;
  const args = resolveArgBody({ name: item.toolName, bashCommand, argSegments: segments });
  const label = args.length > 0 ? `${item.toolName}(${args})` : item.toolName;
  const color = item.status === "error" ? Color.error : Color.text;
  const rows = wrapOutputRows(renderTextWithStyles(label, { color }), width);
  if (item.status === "running") {
    rows.push(renderTextWithStyles("Running…", { color: Color.muted }));
  }
  return rows;
}

function plainEntryLines(
  text: string,
  width: number,
  prefix: string,
  prefixColor: (typeof Color)[keyof typeof Color],
  bodyColor: (typeof Color)[keyof typeof Color],
): string[] {
  const bodyWidth = Math.max(1, width - stringWidth(prefix));
  const bodyStyles = bodyColor === undefined ? {} : { color: bodyColor };
  const prefixStyles = prefixColor === undefined ? {} : { color: prefixColor };
  const body = wrapProse(renderTextWithStyles(text, bodyStyles), bodyWidth);
  return prefixBodyRows(prefix, prefixStyles, body);
}

function prefixBodyRows(
  prefix: string,
  prefixStyles: Parameters<typeof renderTextWithStyles>[1],
  body: readonly string[],
): string[] {
  const styledPrefix = renderTextWithStyles(prefix, prefixStyles);
  const continuation = " ".repeat(stringWidth(prefix));
  return body.map((line, index) => `${index === 0 ? styledPrefix : continuation}${line}`);
}

function assistantEntryLines(
  entry: Extract<SettledEntry, { kind: "assistant" }>,
  width: number,
): string[] {
  const bodyWidth = Math.max(1, width - ASSISTANT_GUTTER_WIDTH);
  const body = renderMarkdownLines(entry.text, bodyWidth);
  const indent = " ".repeat(ASSISTANT_GUTTER_WIDTH);
  const gutter =
    entry.continuation === true
      ? indent
      : renderTextWithStyles(ASSISTANT_GUTTER, { color: Color.assistant });
  if (body.length === 0) return [gutter];
  return body.map((line, index) => (index === 0 ? gutter : indent) + line);
}

function userEntryLines(
  entry: Extract<SettledEntry, { kind: "user" }>,
  width: number,
  presentation: TranscriptPresentation,
): string[] {
  const text = presentation === "detailed" ? entry.text : collapseLongUserMessage(entry.text);
  const rows = userMessageLines(text, width);
  const displayRows = rows.length > 0 ? rows : [""];
  const output = displayRows.map((line, index) => {
    const prefix = index === 0 ? Glyph.chevron : "  ";
    const fill = Math.max(0, width - stringWidth(prefix) - stringWidth(line));
    const styledPrefix = renderTextWithStyles(prefix, {
      color: Color.badgePrefix,
      backgroundColor: Color.inverseBg,
    });
    const styledBody = renderTextWithStyles(line + " ".repeat(fill), {
      color: Color.queueText,
      backgroundColor: Color.inverseBg,
    });
    return styledPrefix + styledBody;
  });
  const images = entry.images ?? [];
  images.forEach((image, index) => {
    output.push(
      ...plainEntryLines(
        imageRefLink(image.id ?? index + 1, image.localPath),
        width,
        index === 0 ? GUTTER_HEAD : GUTTER_CONT,
        Color.muted,
        Color.text,
      ),
    );
  });
  if (entry.anchor && !isUuid(entry.anchor)) {
    output.push(...plainEntryLines(entry.anchor, width, GUTTER_HEAD, Color.muted, Color.muted));
  }
  return output;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
