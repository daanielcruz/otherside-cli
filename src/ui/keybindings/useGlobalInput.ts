import type { Dispatch, SetStateAction } from "react";
import { useRef } from "react";
import {
  drainAgentSteers,
  pendingAgentSteerCount,
} from "@/engine/background/subagents/fork/steering.ts";
import {
  type BackgroundTask,
  cancelTaskTree,
  completeTask,
  removeTask as removeBackgroundTask,
  taskRunRef,
} from "@/engine/background/tasks/background.ts";
import * as bgControllers from "@/engine/background/tasks/background-controllers.ts";
import {
  killWorkflowTask,
  pauseWorkflowTask,
  removeWorkflowTask,
} from "@/engine/background/workflows/runtime/store/store.ts";
import type { LocalWorkflowTaskState } from "@/engine/background/workflows/runtime/store/types.ts";
import { killBackground } from "@/engine/tools/builtins/bash.ts";
import { useInput, useTerminalDimensions } from "@/ink";
import type { Broker } from "@/store/app-store/broker.ts";
import { dispatch, overlayStack } from "@/store/index.ts";
import { setPromptMenuOpen, setPromptText } from "@/store/prompt/index.ts";
import {
  type BackgroundFocusAction,
  nextBackgroundFocusDown,
  nextBackgroundFocusUp,
} from "@/ui/app/background-focus.ts";
import { bgPillLabelFor } from "@/ui/app/status-text.ts";
import { panelSelectionFor } from "@/ui/chrome/running-agents-panel.tsx";
import { type CancellationKey, dispatchCancellation } from "@/ui/keybindings/cancel-ladder.ts";
import { topModalLayer } from "@/ui/keybindings/modal-focus.ts";
import type { Overlay } from "@/ui/panels/registry.tsx";

export interface GlobalInputDeps {
  overlay: Overlay;
  broker: Broker;
  busy: boolean;
  backgroundCurrentAgent: () => void;
  panelAgents: BackgroundTask[];
  workflowTasks: LocalWorkflowTaskState[];
  panelFocused: boolean;
  panelSelection: number;
  setPanelFocused: (focused: boolean) => void;
  setPanelSelection: (next: number | ((prev: number) => number)) => void;
  viewingAgentId: string | null;
  bgTasksOpen: boolean;
  bgTasks: BackgroundTask[];
  bgPillFocused: boolean;
  promptText: string;
  setBgTasksOpen: Dispatch<SetStateAction<boolean>>;
  setTasksExpanded: Dispatch<SetStateAction<boolean>>;
  runCancellation: (key: CancellationKey, exitKeyName: "Ctrl-C" | "Ctrl-D") => void;
  pendingInteractive: boolean;
  btwMode: boolean;
  exitBtwMode: () => void;
}

export type GlobalArrowNavigationAction = Exclude<BackgroundFocusAction, "none"> | "handled";

export interface GlobalArrowNavigationState {
  direction: "up" | "down";
  viewingAgent: boolean;
  bgTasksOpen: boolean;
  promptHasText: boolean;
  hasShellPill: boolean;
  panelHasRows: boolean;
  bgPillFocused: boolean;
  panelFocused: boolean;
  panelSelection: number;
  panelMaxIndex: number;
}

export function nextGlobalArrowNavigation(
  state: GlobalArrowNavigationState,
): GlobalArrowNavigationAction | null {
  if (state.viewingAgent) {
    if (state.bgTasksOpen) return "handled";
    if (!state.panelFocused) return "focus-panel-first";
    if (state.direction === "down") {
      return state.panelSelection < state.panelMaxIndex ? "next-panel-row" : "handled";
    }
    return state.panelSelection === 0 ? "blur-panel" : "previous-panel-row";
  }

  if (state.direction === "down" && (state.promptHasText || state.bgTasksOpen)) return null;
  const backgroundState = {
    hasShellPill: state.hasShellPill,
    panelHasRows: state.panelHasRows,
    bgPillFocused: state.bgPillFocused,
    panelFocused: state.panelFocused,
    panelSelection: state.panelSelection,
    panelMaxIndex: state.panelMaxIndex,
  };
  const action =
    state.direction === "down"
      ? nextBackgroundFocusDown(backgroundState)
      : nextBackgroundFocusUp(backgroundState);
  return action === "none" ? null : action;
}

export function dispatchViewedAgentCancellation(input: {
  key: CancellationKey;
  viewingAgentId: string;
  tasks: readonly BackgroundTask[];
  promptText: string;
  setPromptText: (text: string) => void;
  leaveAgentView: () => void;
  stopTask: (task: BackgroundTask) => void;
}): void {
  const task = input.tasks.find((candidate) => candidate.id === input.viewingAgentId);
  const forkId = task?.kind === "agent" ? task.forkId : undefined;
  const restoreSteers = (): void => {
    if (forkId === undefined) return;
    const text = drainAgentSteers(forkId)
      .map((message) => message.text)
      .join("\n");
    if (text.length > 0) input.setPromptText(text);
  };
  const stage = dispatchCancellation(
    input.key,
    {
      panelOpen: false,
      hasPromptText: input.promptText.length > 0,
      queueLength: forkId === undefined ? 0 : pendingAgentSteerCount(forkId),
      turnRunning: task?.status === "running",
      exitArmed: false,
    },
    {
      closePanel: input.leaveAgentView,
      clearPromptText: () => input.setPromptText(""),
      restoreQueuedToPrompt: restoreSteers,
      cancelTurn: () => {
        if (task === undefined) return;
        restoreSteers();
        input.stopTask(task);
      },
      armExitHint: input.leaveAgentView,
      exit: input.leaveAgentView,
    },
  );
  if (stage === null) input.leaveAgentView();
}

function stopBackgroundTask(task: BackgroundTask): void {
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

// Global terminal-input router: the single `useInput` handler for panel focus,
// background-task control, the cancel ladder, and Escape routing. Extracted from
// the render root so app.tsx wires it with a dependency bundle rather than
// inlining ~200 lines of key handling.
export function useGlobalInput(deps: GlobalInputDeps): void {
  const {
    overlay,
    broker,
    busy,
    backgroundCurrentAgent,
    panelAgents,
    workflowTasks,
    panelFocused,
    panelSelection,
    setPanelFocused,
    setPanelSelection,
    viewingAgentId,
    bgTasksOpen,
    bgTasks,
    bgPillFocused,
    promptText,
    setBgTasksOpen,
    setTasksExpanded,
    runCancellation,
    pendingInteractive,
    btwMode,
    exitBtwMode,
  } = deps;

  const ctrlXRef = useRef(false);
  const ctrlXTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { columns } = useTerminalDimensions();

  const leaveAgentView = (): void => {
    dispatch({ type: "view/setViewingAgent", id: null });
    setPanelFocused(false);
    setPromptMenuOpen(false);
  };

  const runViewedAgentCancellation = (key: CancellationKey): void => {
    if (viewingAgentId === null) return;
    dispatchViewedAgentCancellation({
      key,
      viewingAgentId,
      tasks: bgTasks,
      promptText,
      setPromptText,
      leaveAgentView,
      stopTask: stopBackgroundTask,
    });
  };

  useInput((input, key) => {
    if (key.ctrl && input === "x") {
      ctrlXRef.current = true;
      if (ctrlXTimeoutRef.current) clearTimeout(ctrlXTimeoutRef.current);
      ctrlXTimeoutRef.current = setTimeout(() => {
        ctrlXRef.current = false;
      }, 1000);
      return;
    }
    if (key.ctrl && input === "k" && ctrlXRef.current) {
      ctrlXRef.current = false;
      if (ctrlXTimeoutRef.current) clearTimeout(ctrlXTimeoutRef.current);

      const runningAgents = bgTasks.filter((t) => t.status === "running");
      const activeCount = runningAgents.length;
      if (activeCount >= 2 && columns >= 90) {
        for (const target of runningAgents) stopBackgroundTask(target);
      }
      return;
    }

    if (key.shift && key.tab && overlay === null) {
      broker.dispatch({ kind: "cycle_permission_mode" });
      return;
    }
    if (key.ctrl && input === "t" && overlay === null) {
      setTasksExpanded((prev) => !prev);
      return;
    }
    if (key.ctrl && input === "b" && busy) {
      const hasBackgroundable = bgControllers.callIds().some((id) => {
        const c = bgControllers.get(id);
        return c !== undefined && !c.isBackgrounded();
      });
      if (hasBackgroundable) {
        backgroundCurrentAgent();
        return;
      }
    }
    const agentCount = panelAgents.length;
    const workflowCount = workflowTasks.length;
    const panelMaxIndex = agentCount > 0 ? agentCount + workflowCount : workflowCount - 1;
    const panelHasRows = agentCount > 0 || workflowCount > 0;
    if (key.return && panelFocused) {
      const choice = panelSelectionFor(panelSelection, agentCount);
      if (agentCount > 0 && choice.namespace === "agents" && choice.index === 0) {
        dispatch({ type: "view/setViewingAgent", id: null });
      } else if (choice.namespace === "agents") {
        const target = panelAgents[choice.index - 1];
        // Selection stays on the row (same as the main row) so the user can
        // keep navigating views; leaving the panel hands input to the prompt.
        if (target) dispatch({ type: "view/setViewingAgent", id: target.id });
      } else if (choice.namespace === "workflows") {
        const target = workflowTasks[choice.index];
        if (target) dispatch({ type: "view/setWorkflowDetailTarget", id: target.id });
        overlayStack.open("workflows");
        setPanelFocused(false);
      }
      return;
    }
    if (input === "x" && panelFocused) {
      const choice = panelSelectionFor(panelSelection, agentCount);
      const isMainRow = choice.namespace === "agents" && choice.index === 0;
      if (!isMainRow && choice.namespace === "agents") {
        const target = panelAgents[choice.index - 1];
        if (target) {
          if (target.status === "running") {
            stopBackgroundTask(target);
          } else {
            removeBackgroundTask(target.id);
            if (viewingAgentId === target.id) {
              dispatch({ type: "view/setViewingAgent", id: null });
            }
            setPanelSelection((s) => Math.max(0, s - 1));
          }
        }
        return;
      }
      if (choice.namespace === "workflows") {
        const target = workflowTasks[choice.index];
        if (target) {
          if (target.status === "running") {
            pauseWorkflowTask(target.id);
          } else if (target.status === "paused") {
            killWorkflowTask(target.id, true);
          } else {
            removeWorkflowTask(target.id);
            setPanelSelection((s) => Math.max(0, s - 1));
          }
        }
        return;
      }
    }
    // Transcript/background arrow-nav yields to any open modal layer. Permission
    // and ask panels live on their own channels (not the overlay stack), so a
    // bare `overlay === null` check misses them; topModalLayer() is the SoT. The
    // panel's own useInput still receives the key.
    if ((key.upArrow || key.downArrow) && topModalLayer() !== "none") return;
    if (key.upArrow || key.downArrow) {
      const action = nextGlobalArrowNavigation({
        direction: key.upArrow ? "up" : "down",
        viewingAgent: viewingAgentId !== null,
        bgTasksOpen,
        promptHasText: promptText.length > 0,
        hasShellPill: bgPillLabelFor(bgTasks.filter((task) => task.kind === "shell")) !== undefined,
        panelHasRows,
        bgPillFocused,
        panelFocused,
        panelSelection,
        panelMaxIndex,
      });
      if (action !== null) {
        if (action === "focus-shell-pill") {
          setPanelFocused(false);
          dispatch({ type: "view/setBgPillFocused", focused: true });
        } else if (action === "blur-shell-pill") {
          dispatch({ type: "view/setBgPillFocused", focused: false });
        } else if (action === "focus-panel-first") {
          dispatch({ type: "view/setBgPillFocused", focused: false });
          setPanelFocused(true);
          setPanelSelection(0);
        } else if (action === "next-panel-row") {
          setPanelSelection((selection) => Math.min(panelMaxIndex, selection + 1));
        } else if (action === "previous-panel-row") {
          setPanelSelection((selection) => Math.max(0, selection - 1));
        } else if (action === "blur-panel") {
          setPanelFocused(false);
        }
        return;
      }
    }
    if (viewingAgentId === null && key.return && bgPillFocused) {
      setBgTasksOpen(true);
      dispatch({ type: "view/setBgPillFocused", focused: false });
      return;
    }
    // Inside the agent view a bare "x" types into the prompt (the view is a
    // conversation with the agent); stopping the viewed agent stays available
    // through the focused panel's own "x" handler above.
    if (key.ctrl && (input === "c" || input === "d")) {
      if (viewingAgentId !== null) runViewedAgentCancellation("ctrl-c");
      else runCancellation("ctrl-c", input === "d" ? "Ctrl-D" : "Ctrl-C");
      return;
    }
    if (key.escape) {
      if (viewingAgentId !== null) {
        runViewedAgentCancellation("esc");
        return;
      }
      if (panelFocused) {
        setPanelFocused(false);
        return;
      }
      if (overlay !== null || pendingInteractive) return;
      if (btwMode) {
        exitBtwMode();
        return;
      }
      runCancellation("esc", "Ctrl-C");
      return;
    }
  });
}
