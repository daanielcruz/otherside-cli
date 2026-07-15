import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type BackgroundTask,
  list as listBackgroundTasks,
} from "@/engine/background/tasks/background.ts";
import {
  isHidden as isTasksHidden,
  list as listTaskRecords,
  reset as resetTaskList,
  subscribe as subscribeTasks,
} from "@/engine/background/tasks/index.ts";
import { buildPanelTree } from "@/engine/background/tasks/panel-tree.ts";
import { listWorkflowTasks } from "@/engine/background/workflows/runtime/store/store.ts";
import type { LocalWorkflowTaskState } from "@/engine/background/workflows/runtime/store/types.ts";
import { useTerminalDimensions } from "@/ink";
import { appStore, dispatch, transcriptActions, useAppSelect } from "@/store/index.ts";
import { displacingOverlayClosed } from "@/ui/chrome/overlay.ts";
import {
  panelSelectionFor,
  remapPanelSelectionForAgentCountChange,
  runningPanelHint,
} from "@/ui/chrome/running-agents-panel.tsx";
import type { Overlay } from "@/ui/panels/registry.tsx";

export interface AppTaskStateDeps {
  overlay: Overlay;
  pendingInteractive: boolean;
  quotaPanel: unknown;
  errorPanel: unknown;
}

const ALL_COMPLETED_RESET_DELAY_MS = 5_000;

export function useAppTaskState(deps: AppTaskStateDeps) {
  const { overlay, pendingInteractive, quotaPanel, errorPanel } = deps;
  const [bgTasks, setBgTasks] = useState<BackgroundTask[]>(() => listBackgroundTasks());
  const [workflowTasks, setWorkflowTasks] = useState<LocalWorkflowTaskState[]>(() =>
    listWorkflowTasks(),
  );
  const rawAgents = useMemo(
    () => bgTasks.filter((t) => t.kind === "agent" && t.isBackgrounded && !t.isSidechain),
    [bgTasks],
  );

  const lastVisibleAgentsRef = useRef<BackgroundTask[]>([]);
  const panelSelection = useAppSelect((s) => s.view.panelSelection);
  const setPanelSelection = useCallback(
    (next: number | ((prev: number) => number)) =>
      dispatch({
        type: "view/setPanelSelection",
        value: typeof next === "function" ? next(appStore.getState().view.panelSelection) : next,
      }),
    [],
  );

  const viewingAgentId = useAppSelect((s) => s.view.viewingAgentId);
  const focusedTaskId: string | undefined = viewingAgentId ?? undefined;

  const { orderedVisibleNodes } = useMemo(() => {
    return buildPanelTree(rawAgents, focusedTaskId);
  }, [rawAgents, focusedTaskId]);

  const panelAgents = useMemo(
    () =>
      orderedVisibleNodes.map((n) => ({
        ...n.task,
        depth: n.depth,
        hasLaterSibling: n.hasLaterSibling,
        transitiveHiddenCount: n.transitiveHiddenCount,
      })),
    [orderedVisibleNodes],
  );

  // Selection follows rows, not the viewed agent: when the visible list
  // changes, keep the previously-selected row if it survives, else fall back
  // to the nearest earlier survivor, else the main row.
  useEffect(() => {
    const prevIds = lastVisibleAgentsRef.current.map((t) => t.id);
    const nextIds = panelAgents.map((t) => t.id);
    lastVisibleAgentsRef.current = panelAgents;
    if (prevIds.length === nextIds.length && prevIds.every((id, i) => id === nextIds[i])) return;
    if (panelSelection < 1 || panelSelection > prevIds.length) return;
    for (let i = Math.min(panelSelection, prevIds.length) - 1; i >= 0; i--) {
      const idx = nextIds.indexOf(prevIds[i] as string);
      if (idx !== -1) {
        if (panelSelection !== idx + 1) setPanelSelection(idx + 1);
        return;
      }
    }
    setPanelSelection(0);
  }, [panelAgents, panelSelection, setPanelSelection]);

  const prevAgentCountForSelectionRef = useRef(panelAgents.length);
  useEffect(() => {
    const prevAgentCount = prevAgentCountForSelectionRef.current;
    const nextAgentCount = panelAgents.length;
    if (prevAgentCount !== nextAgentCount) {
      const remapped = remapPanelSelectionForAgentCountChange(
        panelSelection,
        prevAgentCount,
        nextAgentCount,
      );
      if (remapped !== panelSelection) setPanelSelection(remapped);
    }
    prevAgentCountForSelectionRef.current = nextAgentCount;
  }, [panelAgents.length, panelSelection, setPanelSelection]);

  const bgTasksOpen = useAppSelect((s) => s.view.bgTasksOpen);
  const getBgTasksOpen = useCallback(() => appStore.getState().view.bgTasksOpen, []);
  const setBgTasksOpen = useCallback<Dispatch<SetStateAction<boolean>>>((next): void => {
    const open = typeof next === "function" ? next(appStore.getState().view.bgTasksOpen) : next;
    dispatch({ type: "view/setBgTasksOpen", open });
  }, []);
  const prevOverlayRef = useRef<Overlay>(overlay);
  const prevQuotaActiveRef = useRef(quotaPanel !== null);
  const prevErrorActiveRef = useRef(errorPanel !== null);
  const prevBgTasksOpenRef = useRef(bgTasksOpen);
  const workflowDetailOpen = useAppSelect((s) => s.view.workflowDetailOpen);
  const prevWorkflowDetailOpenRef = useRef(workflowDetailOpen);
  useLayoutEffect(() => {
    void pendingInteractive;
    const previousOverlay = prevOverlayRef.current;
    prevOverlayRef.current = overlay;
    const quotaActive = quotaPanel !== null;
    const errorActive = errorPanel !== null;
    const overlayClosedDisplacing = displacingOverlayClosed(overlay, previousOverlay);
    const quotaClosed = !quotaActive && prevQuotaActiveRef.current;
    const errorClosed = !errorActive && prevErrorActiveRef.current;
    const bgTasksClosed = !bgTasksOpen && prevBgTasksOpenRef.current;
    const workflowDetailClosed = !workflowDetailOpen && prevWorkflowDetailOpenRef.current;
    prevQuotaActiveRef.current = quotaActive;
    prevErrorActiveRef.current = errorActive;
    prevBgTasksOpenRef.current = bgTasksOpen;
    prevWorkflowDetailOpenRef.current = workflowDetailOpen;
    if (
      overlayClosedDisplacing ||
      quotaClosed ||
      errorClosed ||
      bgTasksClosed ||
      workflowDetailClosed
    ) {
      transcriptActions.resetFlushCursor();
      dispatch({ type: "view/bumpLogEpoch" });
    }
  }, [overlay, pendingInteractive, quotaPanel, errorPanel, bgTasksOpen, workflowDetailOpen]);
  const bgPillFocused = useAppSelect((s) => s.view.bgPillFocused);
  const workflowDetailTargetId = useAppSelect((s) => s.view.workflowDetailTargetId);
  useEffect(() => {
    if (overlay !== "workflows") {
      dispatch({ type: "view/setWorkflowDetailTarget", id: null });
      dispatch({ type: "view/setWorkflowDetailOpen", open: false });
    }
  }, [overlay]);
  const panelFocused = useAppSelect((s) => s.view.panelFocused);
  const setPanelFocused = useCallback(
    (focused: boolean) => dispatch({ type: "view/setPanelFocused", focused }),
    [],
  );
  const panelSelectionValue = useMemo(
    () => (panelFocused ? panelSelectionFor(panelSelection, panelAgents.length) : undefined),
    [panelFocused, panelSelection, panelAgents],
  );
  const { columns } = useTerminalDimensions();
  const activeAgentCount = useMemo(
    () => bgTasks.filter((t) => t.status === "running").length,
    [bgTasks],
  );

  const panelStatusHint = useMemo(() => {
    if (panelSelectionValue === undefined) return undefined;
    const focusedAgent =
      panelSelectionValue.namespace === "agents" && panelSelectionValue.index > 0
        ? panelAgents[panelSelectionValue.index - 1]
        : undefined;
    const focusedWorkflow =
      panelSelectionValue.namespace === "workflows"
        ? workflowTasks[panelSelectionValue.index]
        : undefined;
    return runningPanelHint(panelFocused, focusedAgent, focusedWorkflow, activeAgentCount, columns);
  }, [panelFocused, panelSelectionValue, panelAgents, workflowTasks, activeAgentCount, columns]);
  useEffect(() => {
    if (!panelFocused) return;
    const agentCount = panelAgents.length;
    const workflowCount = workflowTasks.length;
    const panelHasRows = agentCount > 0 || workflowCount > 0;
    if (!panelHasRows) {
      setPanelFocused(false);
      setPanelSelection(0);
      return;
    }
    // Rows shrank under the caret (agents completed mid-navigation): clamp to
    // the last row and keep focus — the survive-row remap owns exact placement.
    // Updater form reads the live value so a same-commit remap is not clobbered.
    const panelMaxIndex = agentCount > 0 ? agentCount + workflowCount : workflowCount - 1;
    if (panelSelection > panelMaxIndex) setPanelSelection((prev) => Math.min(prev, panelMaxIndex));
  }, [panelFocused, panelSelection, panelAgents, workflowTasks]);
  useEffect(() => {
    if (viewingAgentId === null) return;
    if (!bgTasks.some((t) => t.id === viewingAgentId)) {
      dispatch({ type: "view/setViewingAgent", id: null });
    }
  }, [viewingAgentId, bgTasks]);

  const tasksExpanded = useAppSelect((s) => s.view.tasksExpanded);
  const setTasksExpanded = useCallback<Dispatch<SetStateAction<boolean>>>((next): void => {
    const value = typeof next === "function" ? next(appStore.getState().view.tasksExpanded) : next;
    dispatch({ type: "view/setTasksExpanded", value });
  }, []);
  const remoteSyncStatus = useAppSelect((s) => s.view.remoteSyncStatus);

  const [, setHasTasks] = useState(() => !isTasksHidden());
  useEffect(() => {
    const syncTaskVisibility = (): void => {
      const hidden = isTasksHidden();
      setHasTasks(!hidden);
      if (hidden) setTasksExpanded(false);
    };
    syncTaskVisibility();
    return subscribeTasks(syncTaskVisibility);
  }, []);

  // Whole-list cleanup: 5s after every task is completed the entire list
  // resets (records deleted, highwatermark preserved). Owned by this
  // always-mounted hook — widgets mount/unmount per turn and cannot carry the
  // timer. The fire-time re-read guards against tasks reopened in the window.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancel = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const allCompleted = (): boolean => {
      const records = listTaskRecords().filter((t) => t.metadata._internal !== true);
      return records.length > 0 && records.every((t) => t.status === "completed");
    };
    const syncResetTimer = (): void => {
      if (!allCompleted()) {
        cancel();
        return;
      }
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        if (allCompleted()) resetTaskList();
      }, ALL_COMPLETED_RESET_DELAY_MS);
      timer.unref?.();
    };
    syncResetTimer();
    const unsubscribe = subscribeTasks(syncResetTimer);
    return () => {
      unsubscribe();
      cancel();
    };
  }, []);

  return {
    bgTasks,
    setBgTasks,
    workflowTasks,
    setWorkflowTasks,
    panelAgents,
    bgTasksOpen,
    getBgTasksOpen,
    setBgTasksOpen,
    bgPillFocused,
    workflowDetailTargetId,
    workflowDetailOpen,
    panelFocused,
    setPanelFocused,
    panelSelection,
    setPanelSelection,
    panelSelectionValue,
    panelStatusHint,
    viewingAgentId,
    tasksExpanded,
    setTasksExpanded,
    remoteSyncStatus,
  };
}
