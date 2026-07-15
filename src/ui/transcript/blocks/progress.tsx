import type * as React from "react";
import { memo, useEffect, useState } from "react";
import {
  isHidden as isTasksHidden,
  list as listTasks,
  subscribe as subscribeTasks,
  type TaskRecord,
} from "@/engine/background/tasks/index.ts";
import type { SpinnerMode, ThinkingStatus } from "@/store/app-store/slices/view.ts";
import { useLiveOutputTokens } from "@/store/live-tokens/index.ts";
import {
  findNextPendingTask,
  isInternalTask,
  TaskListInline,
} from "@/ui/transcript/blocks/task-list-inline.tsx";
import { type RetryStatusLine, ThinkingBlock } from "@/ui/transcript/blocks/thinking.tsx";

export interface ProgressBlockProps {
  active: boolean;
  startedAt: number | null;
  tipIndex: number;
  verb: string;
  spinnerMode: SpinnerMode;
  thinkingStatus: ThinkingStatus;
  thinkingSuffix?: string;
  showTip: boolean;
  tasksExpanded: boolean;
  retryStatus: RetryStatusLine | null;
}

function ProgressBlockImpl(props: ProgressBlockProps): React.JSX.Element | null {
  const tokenCount = useLiveOutputTokens();
  const [tasks, setTasks] = useState<TaskRecord[]>(() => listTasks());
  useEffect(() => subscribeTasks(() => setTasks(listTasks())), []);

  if (!props.active && props.tasksExpanded && !isTasksHidden())
    return <TaskListInline standalone />;

  const showTaskList =
    (props.verb === "Compacting conversation" || props.tasksExpanded) && !isTasksHidden();
  const nextPending =
    !showTaskList && props.active
      ? findNextPendingTask(tasks.filter((t) => !isInternalTask(t)))
      : undefined;
  const tb: React.ComponentProps<typeof ThinkingBlock> = {
    active: props.active,
    startedAt: props.startedAt,
    tipIndex: props.tipIndex,
    verb: props.verb,
    tokenCount,
    spinnerMode: props.spinnerMode,
    thinkingStatus: props.thinkingStatus,
    showTip: props.showTip,
    progressBar: props.verb === "Compacting conversation",
    retryStatus: props.retryStatus,
    ...(props.thinkingSuffix !== undefined ? { thinkingSuffix: props.thinkingSuffix } : {}),
    ...(showTaskList ? { taskList: <TaskListInline /> } : {}),
    ...(nextPending !== undefined
      ? {
          nextPendingSubject: nextPending.subject,
          nextHint: `(ctrl+t to ${props.tasksExpanded ? "hide" : "show"} tasks)`,
        }
      : {}),
  };
  return <ThinkingBlock {...tb} />;
}

export const ProgressBlock = memo(ProgressBlockImpl);
