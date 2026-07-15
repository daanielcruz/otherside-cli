import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { slugifyWorkflowName } from "@/engine/background/workflows/runtime/history/paths.ts";
import {
  loadWorkflowHistory,
  type WorkflowSnapshot,
} from "@/engine/background/workflows/runtime/history/snapshot.ts";
import type { WorkflowPhaseDescriptor } from "@/engine/background/workflows/runtime/parser/types.ts";
import { findGitRoot } from "@/engine/background/workflows/runtime/registry/registry.ts";
import {
  buildWorkflowResumeCall,
  killWorkflowTask,
  pauseWorkflowTask,
  retryWorkflowAgent,
  skipWorkflowAgent,
} from "@/engine/background/workflows/runtime/store/store.ts";
import type {
  LocalWorkflowTaskState,
  WorkflowProgressEntry,
  WorkflowTaskStatus,
} from "@/engine/background/workflows/runtime/store/types.ts";
import { Box, Text, useTerminalDimensions } from "@/ink";
import { isErrno } from "@/kernel/std/errno.ts";
import { formatDuration, formatTokens } from "@/kernel/std/text/format.ts";
import { readWorkflowTasksSlice, useAppSelect } from "@/store/index.ts";
import { getPromptText, setPromptText } from "@/store/prompt/index.ts";
import { FooterPanel, ListPanel, type ListPanelItem } from "@/ui/chrome/panel.tsx";
import { CROSS, PAUSE_GLYPH, TICK } from "@/ui/chrome/progress/glyphs.ts";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { useDisposableInterval } from "@/ui/panels/use-disposable-interval";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";
import {
  type WorkflowDetailItem,
  WorkflowDetailPanel,
} from "@/ui/panels/workflow-detail/index.tsx";
import { Color, Glyph } from "@/ui/theme/theme.ts";

const NAME_MAX_CHARS = 50;
const META_SEPARATOR = " · ";
const _WINDOW_MIN_ROWS = 3;
const _WINDOW_CHROME_ROWS = 7;
const _ROW_INDENT = "  ";
const SPINNER_GLYPH = "⟳";
const WORKFLOW_DIR_SEGMENTS = [".otherside", "workflows"];
const EMPTY_WORKFLOW_TASKS: LocalWorkflowTaskState[] = [];

export interface WorkflowListItem {
  id: string;
  runId: string;
  name: string;
  description: string;
  status: WorkflowTaskStatus;
  agentCount: number;
  totalTokens: number;
  durationMs: number;
  startTime: number;
  script: string;
  scriptPath?: string;
  args?: unknown;
  logs: string[];
  phases: WorkflowPhaseDescriptor[];
  workflowProgress: WorkflowProgressEntry[];
  live: boolean;
}

type ViewMode =
  | { mode: "list" }
  | { mode: "detail"; itemId: string }
  | { mode: "save"; itemId: string }
  | { mode: "saved"; path: string }
  | { mode: "save-error"; itemId: string; path: string };

export interface WorkflowsOverlayProps {
  sessionId: string;
  cwd: string;
  onClose?: () => void;
  initialDetailItemId?: string;
  onDetailOpenChange?: (open: boolean) => void;
}

export function WorkflowsOverlay({
  sessionId,
  cwd,
  onClose,
  initialDetailItemId,
  onDetailOpenChange,
}: WorkflowsOverlayProps): React.JSX.Element {
  const close = useOverlayClose(onClose);
  const { rows } = useTerminalDimensions();
  const liveTasks = useAppSelect((s) => readWorkflowTasksSlice(s.engine) ?? EMPTY_WORKFLOW_TASKS);
  const [history, setHistory] = useState<WorkflowSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [, setTick] = useState(0);
  const [idx, setIdx] = useState(0);

  const hasRunning = liveTasks.some((task) => task.status === "running");
  useDisposableInterval(() => setTick((n) => n + 1), 1000, { active: hasRunning });
  const [view, setView] = useState<ViewMode>(() =>
    initialDetailItemId ? { mode: "detail", itemId: initialDetailItemId } : { mode: "list" },
  );
  const [saveScope, setSaveScope] = useState<0 | 1>(0);
  useLayoutEffect(() => {
    onDetailOpenChange?.(view.mode === "detail");
    return () => onDetailOpenChange?.(false);
  }, [onDetailOpenChange, view.mode]);
  const autoOpened = useRef(false);
  const directDetail = useRef(initialDetailItemId !== undefined);
  // Project-scope saves anchor to the repository root (matching the registry's
  // own read-side walk) so they land in the shared location regardless of
  // which subdirectory the panel was opened from.
  const projectRoot = useMemo(() => findGitRoot(cwd) ?? cwd, [cwd]);

  // Reload when the live id set changes, not just on mount: when a completed
  // task evicts from the store mid-view, the row falls back to its history
  // snapshot — served stale (launch/mid-run state) unless re-read from disk.
  const liveIdsKey = liveTasks.map((task) => task.workflowRunId).join(",");
  useEffect(() => {
    let alive = true;
    void loadWorkflowHistory(cwd, sessionId)
      .then((snapshots) => {
        if (!alive) return;
        setHistory(snapshots);
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [cwd, sessionId, liveIdsKey]);

  const items = mergeItems(liveTasks, history);
  const selected = items[Math.min(idx, Math.max(0, items.length - 1))];
  const ignoreListPanelInput = useCallback((_index: number): void => {}, []);

  useEffect(() => {
    if (loading || autoOpened.current) return;
    if (items.length === 1 && view.mode === "list") {
      autoOpened.current = true;
      const only = items[0];
      if (only) setView({ mode: "detail", itemId: only.id });
    }
  }, [loading, items, view.mode]);

  const saveTo = useCallback(
    (item: WorkflowListItem, scope: 0 | 1): void => {
      const root = scope === 0 ? projectRoot : homedir();
      const dir = join(root, ...WORKFLOW_DIR_SEGMENTS);
      const path = join(dir, `${slugifyWorkflowName(item.name)}.js`);
      void mkdir(dir, { recursive: true })
        // "wx" refuses to clobber an existing file — a re-save under the same
        // slug fails loudly instead of silently overwriting someone's script.
        .then(() => writeFile(path, item.script, { encoding: "utf8", flag: "wx" }))
        .then(() => setView({ mode: "saved", path }))
        .catch((error: unknown) => {
          setView(
            isErrno(error, "EEXIST")
              ? { mode: "save-error", itemId: item.id, path }
              : { mode: "list" },
          );
        });
    },
    [projectRoot],
  );

  // One-shot resume: prefills the main session input with the exact
  // Workflow(...) call that continues this paused run, instead of requiring
  // the user to hand-craft it. The user still reviews/submits it themselves.
  const resumeWorkflow = useCallback(
    (item: WorkflowListItem): void => {
      if (item.scriptPath === undefined) return;
      const call = buildWorkflowResumeCall({
        scriptPath: item.scriptPath,
        runId: item.runId,
        args: item.args,
      });
      const prompt = `Resume the paused workflow: ${call}`;
      const existing = getPromptText();
      setPromptText(existing.length > 0 ? `${prompt}\n${existing}` : prompt);
      close();
    },
    [close],
  );

  const goBackFromDetail = useCallback((): void => {
    if (directDetail.current) {
      close();
      return;
    }
    if (autoOpened.current && items.length <= 1) {
      close();
      return;
    }
    autoOpened.current = false;
    setView({ mode: "list" });
  }, [close, items.length]);

  usePanelNavigation({
    onClose: close,
    skipEsc: true,
    onKey: (input, key) => {
      if (view.mode === "saved") {
        setView({ mode: "list" });
        return true;
      }
      if (view.mode === "save-error") {
        setView({ mode: "save", itemId: view.itemId });
        return true;
      }
      if (view.mode === "save") {
        if (key.escape || key.leftArrow) {
          setView({ mode: "detail", itemId: view.itemId });
          return true;
        }
        if (key.upArrow || key.downArrow) {
          setSaveScope((scope) => (scope === 0 ? 1 : 0));
          return true;
        }
        if (key.return) {
          const item = items.find((candidate) => candidate.id === view.itemId);
          if (item) saveTo(item, saveScope);
          return true;
        }
        return false;
      }
      if (view.mode === "detail") {
        const found = items.find((candidate) => candidate.id === view.itemId);
        if (!found && (key.escape || key.leftArrow)) goBackFromDetail();
        return true;
      }
      if (key.escape || key.leftArrow) {
        close();
        return true;
      }
      if (key.upArrow) {
        setIdx((current) => Math.max(0, current - 1));
        return true;
      }
      if (key.downArrow) {
        setIdx((current) => Math.min(Math.max(0, items.length - 1), current + 1));
        return true;
      }
      if (key.return) {
        if (selected) setView({ mode: "detail", itemId: selected.id });
        return true;
      }
      if (input === "x" && selected && selected.status === "running") {
        pauseWorkflowTask(selected.id);
        return true;
      }
      if (input === "x" && selected && selected.status === "paused") {
        killWorkflowTask(selected.id, true);
        return true;
      }
      if (input === "s" && selected && selected.script.length > 0) {
        setSaveScope(0);
        setView({ mode: "save", itemId: selected.id });
        return true;
      }
      return false;
    },
  });

  if (view.mode === "saved") {
    return (
      <FooterPanel
        command="/workflows"
        title="Dynamic workflows"
        footerHints={[["any key", "continue"]]}
      >
        <Text color={Color.success}>Saved workflow to {view.path}</Text>
      </FooterPanel>
    );
  }

  if (view.mode === "save-error") {
    return (
      <FooterPanel command="/workflows" title="Save workflow" footerHints={[["any key", "back"]]}>
        <Text color={Color.error}>A workflow already exists at {view.path}.</Text>
        <Text color={Color.muted}>Pick a different scope, or rename/remove the existing file.</Text>
      </FooterPanel>
    );
  }

  if (view.mode === "save") {
    const item = items.find((candidate) => candidate.id === view.itemId);
    return (
      <FooterPanel
        command="/workflows"
        title={`Save workflow: ${item?.name ?? ""}`}
        footerHints={[
          ["↑/↓", "select scope"],
          ["Enter", "save"],
          ["Esc", "back"],
        ]}
      >
        <SaveScopeRow
          label={`Project (${join(projectRoot, ...WORKFLOW_DIR_SEGMENTS)})`}
          selected={saveScope === 0}
        />
        <SaveScopeRow
          label={`User (${join(homedir(), ...WORKFLOW_DIR_SEGMENTS)})`}
          selected={saveScope === 1}
        />
      </FooterPanel>
    );
  }

  if (view.mode === "detail") {
    const item = items.find((candidate) => candidate.id === view.itemId);
    if (!item) {
      return (
        <FooterPanel command="/workflows" title="Dynamic workflows" footerHints={[["Esc", "back"]]}>
          <Text color={Color.muted}>Workflow not found.</Text>
        </FooterPanel>
      );
    }
    const canStop = item.status === "running";
    const canSave = item.script.length > 0;
    const canResume = item.status === "paused" && item.scriptPath !== undefined;
    return (
      <WorkflowDetailPanel
        item={detailItem(item)}
        onBack={goBackFromDetail}
        {...(canStop ? { onStop: () => killWorkflowTask(item.id, true) } : {})}
        {...(canStop ? { onPause: () => pauseWorkflowTask(item.id) } : {})}
        {...(canStop ? { onSkip: (agentId: string) => skipWorkflowAgent(agentId) } : {})}
        {...(canStop ? { onRetry: (agentId: string) => retryWorkflowAgent(agentId) } : {})}
        {...(canResume ? { onResume: () => resumeWorkflow(item) } : {})}
        {...(canSave
          ? {
              onSave: () => {
                setSaveScope(0);
                setView({ mode: "save", itemId: item.id });
              },
            }
          : {})}
      />
    );
  }

  const hints: [string, string][] = [];
  if (items.length > 0) {
    hints.push(["↑/↓", "select"], ["Enter", "view"]);
    if (selected?.status === "running") hints.push(["x", "pause"]);
    else if (selected?.status === "paused") hints.push(["x", "kill"]);
    if (selected !== undefined && selected.script.length > 0) hints.push(["s", "save"]);
  }
  hints.push(["Esc", "close"]);

  const listItems: ListPanelItem[] = items.map((item) => {
    return {
      id: item.id,
      label: (
        <Box>
          <StatusGlyph status={item.status} />
          <Text color={Color.text}> {truncateName(item.name)}</Text>
        </Box>
      ),
      value: rowMeta(item),
    };
  });

  return (
    <ListPanel
      command="/workflows"
      title="Dynamic workflows"
      subtitle={subtitleNode(items)}
      items={listItems}
      selectedIndex={idx}
      onSelectedIndexChange={ignoreListPanelInput}
      footerHints={hints}
    >
      {loading && items.length === 0 && (
        <Text color={Color.muted}>Loading dynamic workflow history…</Text>
      )}
    </ListPanel>
  );
}

export function subtitleNode(items: WorkflowListItem[]): ReactNode {
  if (items.length === 0) return undefined;
  const runningCount = items.filter((item) => item.status === "running").length;
  const completedCount = items.length - runningCount;
  const parts: string[] = [];
  if (runningCount > 0) parts.push(`${runningCount} running`);
  if (completedCount > 0) parts.push(`${completedCount} done`);
  return parts.join(META_SEPARATOR);
}

function StatusGlyph({ status }: { status: WorkflowTaskStatus }): React.JSX.Element {
  if (status === "completed") return <Text color={Color.success}>{TICK}</Text>;
  if (status === "failed" || status === "killed") return <Text color={Color.error}>{CROSS}</Text>;
  if (status === "paused") return <Text color={Color.warning}>{PAUSE_GLYPH}</Text>;
  return <Text color={Color.text}>{SPINNER_GLYPH}</Text>;
}

function detailItem(item: WorkflowListItem): WorkflowDetailItem {
  return {
    name: item.name,
    description: item.description,
    status: item.status,
    startTime: item.startTime,
    durationMs: item.durationMs,
    agentCount: item.agentCount,
    script: item.script,
    phases: item.phases,
    workflowProgress: item.workflowProgress,
  };
}

function SaveScopeRow({
  label,
  selected,
}: {
  label: string;
  selected: boolean;
}): React.JSX.Element {
  return (
    <Box>
      <Text color={selected ? Color.primaryGlow : Color.muted}>
        {selected ? Glyph.chevron : "  "}
      </Text>
      <Text color={Color.text} bold={selected}>
        {label}
      </Text>
    </Box>
  );
}

function mergeItems(
  liveTasks: LocalWorkflowTaskState[],
  history: WorkflowSnapshot[],
): WorkflowListItem[] {
  const liveRunIds = new Set(liveTasks.map((task) => task.workflowRunId));
  const items: WorkflowListItem[] = liveTasks.map(liveItem);
  for (const snapshot of history) {
    if (liveRunIds.has(snapshot.workflowRunId ?? snapshot.runId)) continue;
    items.push(snapshotItem(snapshot));
  }
  return items.sort((left, right) => right.startTime - left.startTime);
}

function liveItem(task: LocalWorkflowTaskState): WorkflowListItem {
  return {
    id: task.id,
    runId: task.workflowRunId,
    name: task.title ?? task.workflowName,
    description: task.description,
    status: task.status,
    agentCount: task.agentCount,
    totalTokens: task.totalTokens,
    durationMs: (task.endedAt ?? Date.now()) - task.startedAt,
    startTime: task.startedAt,
    script: task.script ?? "",
    ...(task.scriptPath !== undefined ? { scriptPath: task.scriptPath } : {}),
    args: task.args,
    logs: task.logs,
    phases: task.phases ?? [],
    workflowProgress: task.workflowProgress,
    live: true,
  };
}

function snapshotItem(snapshot: WorkflowSnapshot): WorkflowListItem {
  return {
    id: snapshot.taskId,
    runId: snapshot.workflowRunId ?? snapshot.runId,
    name: snapshot.title ?? snapshot.workflowName ?? snapshot.summary ?? snapshot.runId,
    description: snapshot.summary ?? "",
    status: snapshot.status,
    agentCount: snapshot.agentCount,
    totalTokens: snapshot.totalTokens,
    durationMs: snapshot.durationMs,
    startTime: snapshot.startTime,
    script: snapshot.script,
    ...(snapshot.scriptPath !== undefined ? { scriptPath: snapshot.scriptPath } : {}),
    args: snapshot.args,
    logs: snapshot.logs,
    phases: snapshot.phases ?? [],
    workflowProgress: snapshot.workflowProgress,
    live: false,
  };
}

function rowMeta(item: WorkflowListItem): string {
  const parts: string[] = [];
  if (item.agentCount > 0) {
    parts.push(`${item.agentCount} agent${item.agentCount === 1 ? "" : "s"}`);
  }
  if (item.totalTokens > 0) parts.push(`${formatTokens(item.totalTokens)} tok`);
  parts.push(formatDuration(item.durationMs));
  return parts.join(META_SEPARATOR);
}

function truncateName(name: string): string {
  if (name.length <= NAME_MAX_CHARS) return name;
  return `${name.slice(0, NAME_MAX_CHARS - 1)}…`;
}
