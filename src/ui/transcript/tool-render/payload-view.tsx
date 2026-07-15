import { INTERRUPTED_FEEDBACK } from "@/engine/queue/runtime/interruption-text.ts";
import { AnsiText, Box, colorize, type Color as InkColor, RawSequence, Text } from "@/ink";
import { Color, GUTTER_CONT, GUTTER_HEAD } from "@/ui/theme/theme.ts";
import {
  dedupeKey,
  renderDiffAnsiLines,
  renderDiffLines,
} from "@/ui/transcript/tool-render/diff.tsx";
import { expandTabsForRender, wrapShellOutput } from "@/ui/transcript/tool-render/format.ts";
import type { ToolPayload } from "@/ui/transcript/tool-render/types.ts";
import { WorkflowTaskStatus } from "@/ui/transcript/workflow-status.tsx";

type TextPayload = Extract<ToolPayload, { kind: "preview" | "progress" | "hint" }>;
type WorkflowPayload = Extract<ToolPayload, { kind: "workflow" }>;
type DiffPayload = Extract<ToolPayload, { kind: "diff" }>;
type BashPayload = Extract<ToolPayload, { kind: "bash" }>;

function previewBodyColor(kind: "preview" | "progress" | "hint", isError: boolean): InkColor {
  if (kind === "progress" || kind === "hint") return Color.muted;
  if (isError) return Color.error;
  return Color.toolBody;
}

function renderTextPayload(
  payload: TextPayload,
  headPrefix: string,
  isError: boolean,
): React.JSX.Element[] {
  const PROGRESS_MAX_LINES = 8;
  const allRows = payload.text
    .replace(/\n+$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n");
  let rows: string[];
  if (payload.kind === "progress" && allRows.length > PROGRESS_MAX_LINES) {
    const overflow = allRows.length - PROGRESS_MAX_LINES;
    rows = [...allRows.slice(overflow), `… +${overflow} lines`];
  } else {
    rows = allRows;
  }
  const seen = new Map<string, number>();
  const bodyColor = previewBodyColor(payload.kind, isError);
  return rows.map((raw, i) => (
    <Text key={dedupeKey(payload.kind, raw, seen)}>
      <Text color={Color.muted}>{i === 0 ? headPrefix : GUTTER_CONT}</Text>
      <Text color={bodyColor}>{expandTabsForRender(raw)}</Text>
    </Text>
  ));
}

function renderInterruptPayload(headPrefix: string): React.JSX.Element[] {
  return [
    <Text key="interrupt">
      <Text color={Color.muted}>{headPrefix}</Text>
      <Text color={Color.muted}>{INTERRUPTED_FEEDBACK}</Text>
    </Text>,
  ];
}

function renderWorkflowPayload(payload: WorkflowPayload, headPrefix: string): React.JSX.Element[] {
  return [
    <Box key="wf-card">
      <Text color={Color.muted}>{headPrefix}</Text>
      <Box flexDirection="column">
        <WorkflowTaskStatus task={payload.task} />
      </Box>
    </Box>,
  ];
}

function renderDiffPayload(
  payload: DiffPayload,
  headPrefix: string,
  columns: number,
): React.JSX.Element[] {
  const lines: React.JSX.Element[] = [];
  const diffWidth = Math.max(1, columns - GUTTER_CONT.length);
  const ansi = renderDiffAnsiLines(payload.fragment, diffWidth, payload.filePath);
  if (ansi) {
    lines.push(
      <Text key="diff-header">
        <Text color={Color.muted}>{headPrefix}</Text>
        <Text color={Color.muted}>{ansi.headerLines[0]}</Text>
      </Text>,
    );
    const gutterPrefix = colorize(GUTTER_CONT, Color.muted, "foreground");
    const ansiWithGutter = ansi.bodyLines.map((line) => `${gutterPrefix}${line}`);
    lines.push(<RawSequence key="diff-body" lines={ansiWithGutter} width={columns} />);
    return lines;
  }
  const rendered = renderDiffLines(payload.fragment, diffWidth);
  rendered.forEach((row, i) => {
    const prefix = i === 0 ? headPrefix : GUTTER_CONT;
    lines.push(
      <Text key={`diff-${row.key}`}>
        <Text color={Color.muted}>{prefix}</Text>
        {row.element}
      </Text>,
    );
  });
  return lines;
}

function renderBashPayload(
  payload: BashPayload,
  headPrefix: string,
  columns: number,
  isError: boolean,
): React.JSX.Element[] {
  const lines: React.JSX.Element[] = [];
  let emitted = 0;
  const isNoOutput = payload.stdout === "(No output)";
  const isDoneLabel = payload.noOutputExpected === true && payload.stdout === "Done";
  const SANDBOX_VIOLATION_BLOCK = /\n?<sandbox_violations>[\s\S]*?<\/sandbox_violations>\n?/g;
  const cleanStderr = payload.stderr.replace(SANDBOX_VIOLATION_BLOCK, "");
  const CWD_RESET_PATTERN = /(?:^|\n)(Shell cwd was reset to [^\n]*)$/;
  const cleanStderrNoCwd = cleanStderr.replace(CWD_RESET_PATTERN, "");
  const hasStdout = payload.stdout.length > 0 && !isNoOutput && !isDoneLabel;
  const hasStderr = cleanStderrNoCwd.trim().length > 0;
  const bothEmpty = !hasStdout && !hasStderr;

  if (isError) {
    let e = 0;
    if (payload.exitCode > 0 && bothEmpty) {
      lines.push(
        <Text key="err-head">
          <Text color={Color.muted}>{headPrefix}</Text>
          <Text color={Color.error}>{`Error: Exit code ${payload.exitCode}`}</Text>
        </Text>,
      );
      e++;
    }
    const errStdoutLines =
      isNoOutput || isDoneLabel ? [payload.stdout] : wrapShellOutput(payload.stdout, columns);
    if (payload.stdout.length > 0) {
      for (const raw of errStdoutLines) {
        const prefix = e === 0 ? headPrefix : GUTTER_CONT;
        lines.push(
          <Text key={`eo_${e}`}>
            <Text color={Color.muted}>{prefix}</Text>
            <Text color={Color.error}>
              <AnsiText>{raw}</AnsiText>
            </Text>
          </Text>,
        );
        e++;
      }
    }
    if (payload.stderr.length > 0) {
      for (const raw of wrapShellOutput(payload.stderr, columns)) {
        const prefix = e === 0 ? headPrefix : GUTTER_CONT;
        lines.push(
          <Text key={`ee_${e}`}>
            <Text color={Color.muted}>{prefix}</Text>
            <Text color={Color.error}>
              <AnsiText>{raw}</AnsiText>
            </Text>
          </Text>,
        );
        e++;
      }
    }
    return lines;
  }
  const stdoutLines =
    isNoOutput || isDoneLabel ? [payload.stdout] : wrapShellOutput(payload.stdout, columns);
  if (payload.stdout.length > 0) {
    for (const raw of stdoutLines) {
      const prefix = emitted === 0 ? headPrefix : GUTTER_CONT;
      lines.push(
        <Text key={`o_${emitted}`}>
          <Text color={Color.muted}>{prefix}</Text>
          <Text color={isNoOutput || isDoneLabel ? Color.muted : Color.toolBody}>
            <AnsiText>{raw}</AnsiText>
          </Text>
        </Text>,
      );
      emitted++;
    }
  }
  const cwdResetMatch = cleanStderr.match(CWD_RESET_PATTERN);
  const cwdResetText = cwdResetMatch ? (cwdResetMatch[1] ?? null) : null;
  const stderrBody = cwdResetText ? cleanStderrNoCwd.trim() : cleanStderr;
  if (stderrBody.length > 0) {
    for (const raw of wrapShellOutput(stderrBody, columns)) {
      const prefix = emitted === 0 ? headPrefix : GUTTER_CONT;
      const isSandboxLine = raw.startsWith("[sandbox]") || raw.startsWith("  - ");
      const stderrColor = isSandboxLine ? Color.warning : Color.toolBody;
      lines.push(
        <Text key={`e_${emitted}`}>
          <Text color={Color.muted}>{prefix}</Text>
          <Text color={stderrColor}>
            <AnsiText>{raw}</AnsiText>
          </Text>
        </Text>,
      );
      emitted++;
    }
  }
  if (payload.exitCode > 0 && bothEmpty) {
    const prefix = emitted === 0 ? headPrefix : GUTTER_CONT;
    const exitText = payload.returnCodeInterpretation
      ? `Exit code ${payload.exitCode} · ${payload.returnCodeInterpretation}`
      : `Exit code ${payload.exitCode}`;
    lines.push(
      <Text key="exit">
        <Text color={Color.muted}>{prefix}</Text>
        <Text color={Color.error}>{exitText}</Text>
      </Text>,
    );
    emitted++;
  }
  if (cwdResetText) {
    lines.push(
      <Text key="cwd-reset">
        <Text color={Color.muted}>{headPrefix}</Text>
        <Text color={Color.muted}>{cwdResetText}</Text>
      </Text>,
    );
    emitted++;
  }
  return lines;
}

function renderFindingsPayload(
  payload: Extract<ToolPayload, { kind: "findings" }>,
  headPrefix: string,
): React.JSX.Element[] {
  const lines: React.JSX.Element[] = [];
  if (payload.findings.length === 0) {
    lines.push(
      <Text key="empty-findings">
        <Text color={Color.muted}>{headPrefix}</Text>
        <Text color={Color.muted}>No findings reported.</Text>
      </Text>,
    );
    return lines;
  }

  let index = 0;
  for (const f of payload.findings) {
    const prefix = index === 0 ? headPrefix : GUTTER_CONT;

    let verdictEl: React.JSX.Element | null = null;
    if (f.verdict === "CONFIRMED") {
      verdictEl = <Text color={Color.error}> CONFIRMED</Text>;
    } else if (f.verdict === "PLAUSIBLE") {
      verdictEl = <Text color={Color.warning}> PLAUSIBLE</Text>;
    }

    let outcomeEl: React.JSX.Element | null = null;
    if (f.outcome) {
      outcomeEl = <Text color={Color.muted}> [{f.outcome}]</Text>;
    }

    lines.push(
      <Text key={`f_${index}_line`}>
        <Text color={Color.muted}>{prefix}</Text>
        <Text color={Color.toolBody}>
          {f.file}:{f.line} — {f.summary}
        </Text>
        {verdictEl}
        {outcomeEl}
      </Text>,
    );
    index++;

    lines.push(
      <Text key={`f_${index}_scenario`}>
        <Text color={Color.muted}>{GUTTER_CONT}</Text>
        <Text color={Color.muted}> {f.failure_scenario}</Text>
      </Text>,
    );
    index++;
  }

  return lines;
}

export function renderPayload(
  payload: ToolPayload,
  suppressHead = false,
  columns = 80,
  isError = false,
): React.JSX.Element[] {
  const headPrefix = suppressHead ? GUTTER_CONT : GUTTER_HEAD;
  switch (payload.kind) {
    case "preview":
    case "progress":
    case "hint":
      return renderTextPayload(payload, headPrefix, isError);
    case "interrupt":
      return renderInterruptPayload(headPrefix);
    case "workflow":
      return renderWorkflowPayload(payload, headPrefix);
    case "diff":
      return renderDiffPayload(payload, headPrefix, columns);
    case "bash":
      return renderBashPayload(payload, headPrefix, columns, isError);
    case "findings":
      return renderFindingsPayload(payload, headPrefix);
  }
}
