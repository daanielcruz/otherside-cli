import { useEffect, useRef, useState } from "react";
import {
  type BackgroundTask,
  cancelTaskTree,
  completeTask,
  holdTaskEviction,
  taskRunRef,
} from "@/engine/background/tasks/background.ts";
import { killBackground } from "@/engine/tools/builtins/bash.ts";
import { Box, Text } from "@/ink";
import { FooterPanel } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { useOptionalOverlayDispatch, useOptionalOverlayState } from "@/ui/panels/context";
import { useDisposableInterval } from "@/ui/panels/use-disposable-interval";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import { formatTaskSummary, TaskDetail } from "../agents";

const CHORD_WINDOW_MS = 1000;

function killTask(task: BackgroundTask): void {
  if (task.kind === "shell") {
    killBackground(task.id);
    completeTask(task.id, {
      content: "Killed by user",
      isError: false,
      killed: true,
      userInitiated: true,
    });
    return;
  }
  cancelTaskTree(taskRunRef(task), {
    reason: "Killed by user",
    userInitiated: true,
  });
}

function killAllRunning(tasks: BackgroundTask[]): number {
  let killed = 0;
  for (const task of tasks) {
    if (task.status === "running") {
      killTask(task);
      killed += 1;
    }
  }
  return killed;
}

export interface BackgroundTasksOverlayProps {
  tasks?: BackgroundTask[];
  onClose?: () => void;
  onForeground?: (task: BackgroundTask) => void;
}

export function BackgroundTasksOverlay({
  tasks,
  onClose,
  onForeground,
}: BackgroundTasksOverlayProps = {}): React.JSX.Element {
  const state = useOptionalOverlayState();
  const dispatch = useOptionalOverlayDispatch();
  const close = onClose ?? dispatch?.closeOverlay ?? (() => {});
  const visible = tasks ?? state?.tasks ?? [];
  const [selected, setSelected] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(
    visible.length === 1 ? (visible[0]?.id ?? null) : null,
  );

  useEffect(() => {
    if (visible.length === 0) return;
    if (selected >= visible.length) setSelected(visible.length - 1);
    if (detailId && !visible.some((t) => t.id === detailId)) {
      setDetailId(visible.length === 1 ? (visible[0]?.id ?? null) : null);
    }
  }, [visible, selected, detailId]);

  useEffect(() => {
    if (!detailId) return;
    return holdTaskEviction(detailId);
  }, [detailId]);

  const displayTasks = backgroundPanelTasksInDisplayOrder(visible);
  const detailTask = detailId ? (visible.find((t) => t.id === detailId) ?? null) : null;
  const inDetail = detailTask !== null;
  const singleAgent = visible.length === 1;
  const chordPendingAt = useRef<number | null>(null);
  const [, setTick] = useState(0);

  const hasRunning = visible.some((task) => task.status === "running");
  useDisposableInterval(
    () => {
      setTick((t) => t + 1);
    },
    1000,
    { active: hasRunning },
  );

  usePanelNavigation({
    onClose: close,
    skipEsc: true,
    onKey: (input, key) => {
      const now = Date.now();
      const chordPending =
        chordPendingAt.current !== null && now - chordPendingAt.current <= CHORD_WINDOW_MS;

      if (key.ctrl && input === "x") {
        chordPendingAt.current = now;
        return true;
      }
      if (chordPending && key.ctrl && input === "k") {
        chordPendingAt.current = null;
        const killed = killAllRunning(visible);
        if (killed > 0 && singleAgent) close();
        return true;
      }
      chordPendingAt.current = null;

      if (inDetail) {
        if (key.leftArrow) {
          if (singleAgent) close();
          else setDetailId(null);
          return true;
        }
        if (key.escape || key.return || input === " ") {
          close();
          return true;
        }
        if (input === "f" && detailTask?.kind === "agent" && onForeground) {
          onForeground(detailTask);
          return true;
        }
        if (input === "x") {
          if (detailTask) killTask(detailTask);
          if (singleAgent) close();
          else setDetailId(null);
          return true;
        }
        return false;
      }

      if (key.escape || key.leftArrow) {
        close();
        return true;
      }
      if (key.upArrow) {
        setSelected((s) => Math.max(0, s - 1));
        return true;
      }
      if (key.downArrow) {
        setSelected((s) => Math.min(Math.max(0, displayTasks.length - 1), s + 1));
        return true;
      }
      if (key.return) {
        const task = displayTasks[selected];
        if (task) setDetailId(task.id);
        return true;
      }
      if (input === "f") {
        const task = displayTasks[selected];
        if (task?.kind === "agent" && onForeground) onForeground(task);
        return true;
      }
      if (input === "x") {
        const task = displayTasks[selected];
        if (task) killTask(task);
        return true;
      }
      return false;
    },
  });

  if (visible.length === 0) {
    return (
      <FooterPanel
        title="Background tasks"
        accent={Color.primaryGlow}
        footerHints={[["Esc/←", "close"]]}
      >
        <Text color={Color.muted}>no active background tasks</Text>
      </FooterPanel>
    );
  }

  if (inDetail && detailTask) {
    return (
      <FooterPanel
        accent={Color.primaryGlow}
        footerHints={detailFooterHints(detailTask, onForeground)}
      >
        <TaskDetail task={detailTask} />
      </FooterPanel>
    );
  }

  const agents = displayTasks.filter((t) => t.kind === "agent");
  const shells = displayTasks.filter((t) => t.kind === "shell");
  const headerLabel = headerForVisible(agents.length, shells.length);
  const now = Date.now();
  const focusedTask = displayTasks[selected];
  const showForeground = focusedTask?.kind === "agent" && !!onForeground;

  return (
    <FooterPanel
      title="Background tasks"
      accent={Color.primaryGlow}
      footerHints={[
        ["↑/↓", "to select"],
        ["Enter", "to view"],
        ...(showForeground ? ([["f", "foreground"]] as [string, string][]) : []),
        ["x", "to stop"],
        ["ctrl+x ctrl+k", "to stop all"],
        ["←/Esc", "to close"],
      ]}
    >
      <Text>{headerLabel}</Text>
      {agents.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={Color.muted}>
            <Text bold>{"  "}Local agents</Text> ({agents.length})
          </Text>
          {agents.map((task) =>
            renderTaskRow({ task, idx: displayTasks.indexOf(task), selected, now }),
          )}
        </Box>
      )}
      {shells.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={Color.muted}>
            <Text bold>{"  "}Shells</Text> ({shells.length})
          </Text>
          {shells.map((task) =>
            renderTaskRow({ task, idx: displayTasks.indexOf(task), selected, now }),
          )}
        </Box>
      )}
    </FooterPanel>
  );
}

export function backgroundPanelTasksInDisplayOrder(tasks: BackgroundTask[]): BackgroundTask[] {
  return [
    ...tasks.filter((task) => task.kind === "agent"),
    ...tasks.filter((task) => task.kind === "shell"),
  ];
}

function renderTaskRow(args: {
  task: BackgroundTask;
  idx: number;
  selected: number;
  now: number;
}): React.JSX.Element {
  const { task, idx, selected, now } = args;
  const focused = idx === selected;
  return (
    <Box key={task.id}>
      <Text color={focused ? Color.primaryGlow : Color.muted}>
        {focused ? Glyph.chevron : "  "}
      </Text>
      <Text color={Color.text} bold={focused}>
        {task.description ?? task.agentName}
      </Text>
      <Text color={Color.muted}>
        {" "}
        ({task.status}) · {formatTaskSummary(task, now)}
      </Text>
    </Box>
  );
}

function headerForVisible(agents: number, shells: number): string {
  const total = agents + shells;
  if (shells === 0) return `${total} active agent${total === 1 ? "" : "s"}`;
  if (agents === 0) return `${total} active shell${total === 1 ? "" : "s"}`;
  return `${total} active background task${total === 1 ? "" : "s"}`;
}

function detailFooterHints(
  task: BackgroundTask,
  onForeground?: (task: BackgroundTask) => void,
): [string, string][] {
  const hints: [string, string][] = [
    ["←", "to go back"],
    ["Esc/Enter/Space", "to close"],
  ];
  if (task.kind === "agent" && onForeground) hints.push(["f", "foreground"]);
  if (task.status === "running") hints.push(["x", "to stop"]);
  return hints;
}
