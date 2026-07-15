import { useEffect, useState } from "react";
import { computeWorkflowProgress } from "@/engine/background/workflows/runtime/store/progress.ts";
import {
  getWorkflowTaskByParentToolCallId,
  subscribeWorkflowTasks,
} from "@/engine/background/workflows/runtime/store/store.ts";
import type { LocalWorkflowTaskState } from "@/engine/background/workflows/runtime/store/types.ts";
import { Text } from "@/ink";
import { formatDuration, formatTokens } from "@/kernel/std/text/format.ts";
import { pluralize } from "@/kernel/std/text/pluralize.ts";
import { PAUSE_GLYPH, TICK, workflowPanelStatus } from "@/ui/chrome/progress/glyphs.ts";
import { isTerminalWorkflowStatus } from "@/ui/chrome/progress/workflow-row.ts";
import { Color } from "@/ui/theme/theme.ts";

const TERMINAL_CROSS = "✖";
const SUGGESTION_COLOR = Color.primaryGlow;

function sumAgentTokens(task: LocalWorkflowTaskState): number {
  let totalTokens = 0;
  for (const entry of task.workflowProgress) {
    if (entry.type === "workflow_agent" && entry.tokens) totalTokens += entry.tokens;
  }
  return totalTokens === 0 ? task.totalTokens : totalTokens;
}

function BackgroundHint(): React.JSX.Element {
  return (
    <Text>
      <Text dim>Running in background · </Text>
      <Text color={SUGGESTION_COLOR}>/workflows</Text>
      <Text dim> to monitor and save</Text>
    </Text>
  );
}

function RunningStatus(): React.JSX.Element {
  return (
    <Text>
      <Text dim>Running in background · </Text>
      <Text color={SUGGESTION_COLOR}>/workflows</Text>
      <Text dim> for details</Text>
    </Text>
  );
}

function PausedStatus(): React.JSX.Element {
  return (
    <Text>
      <Text color={Color.warning}>{`${PAUSE_GLYPH} `}</Text>
      <Text dim>Paused · </Text>
      <Text color={SUGGESTION_COLOR}>/workflows</Text>
      <Text dim> for details</Text>
    </Text>
  );
}

function terminalLabel(status: LocalWorkflowTaskState["status"]): string {
  const panelStatus = workflowPanelStatus(status) ?? "done";
  return panelStatus.charAt(0).toUpperCase() + panelStatus.slice(1);
}

function TerminalStatus({ task }: { task: LocalWorkflowTaskState }): React.JSX.Element {
  const isError = task.status === "failed" || task.status === "killed";
  const totalTokens = sumAgentTokens(task);
  const progress = computeWorkflowProgress(task.workflowProgress, task.agentCount);
  const durationText =
    task.endedAt && task.startedAt ? ` in ${formatDuration(task.endedAt - task.startedAt)}` : "";
  const agentText =
    progress.total > 0 ? ` · ${progress.total} ${pluralize(progress.total, "agent")}` : "";
  const tokensText = totalTokens > 0 ? ` · ${formatTokens(totalTokens)} tokens` : "";
  const glyph = isError ? TERMINAL_CROSS : TICK;
  const glyphColor = isError ? Color.error : Color.success;
  return (
    <Text>
      <Text color={glyphColor}>{`${glyph} `}</Text>
      <Text dim>{`${terminalLabel(task.status)}${durationText}${agentText}${tokensText}`}</Text>
    </Text>
  );
}

function hasReportedAgents(task: LocalWorkflowTaskState): boolean {
  return task.workflowProgress.some((entry) => entry.type === "workflow_agent");
}

export function WorkflowTaskStatus({ task }: { task: LocalWorkflowTaskState }): React.JSX.Element {
  const [live, setLive] = useState<LocalWorkflowTaskState>(task);
  const settled = isTerminalWorkflowStatus(live.status);

  useEffect(() => {
    if (settled) return;
    return subscribeWorkflowTasks(() => {
      const next = getWorkflowTaskByParentToolCallId(task.parentToolCallId);
      if (next) setLive(next);
    });
  }, [task.parentToolCallId, settled]);

  if (isTerminalWorkflowStatus(live.status)) return <TerminalStatus task={live} />;
  if (live.status === "paused") return <PausedStatus />;
  if (!hasReportedAgents(live)) return <BackgroundHint />;
  return <RunningStatus />;
}
