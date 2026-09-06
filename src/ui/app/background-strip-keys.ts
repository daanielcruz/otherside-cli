import {
  type BackgroundTask,
  get as getBackgroundTask,
  list as listBackgroundTasks,
  removeTaskTree,
  stopTaskForUser,
} from "@/engine/background/tasks/background.ts";
import { killWorkflowTask } from "@/engine/background/workflows/runtime/store/store.ts";
import { appStore, dispatch } from "@/store/app-store/index.ts";
import { overlayStack } from "@/store/overlay-stack/index.ts";
import { armedStopTaskId, armStopConfirm, clearStopConfirm } from "@/store/stop-confirm/index.ts";
import {
  type BackgroundFocusAction,
  type BackgroundFocusState,
  nextBackgroundFocusDown,
  nextBackgroundFocusUp,
} from "@/ui/app/background-focus.ts";
import { bgPillLabelFor } from "@/ui/app/status-text.ts";
import { activeWorkflows, visiblePanelAgents } from "@/ui/chrome/string-view-running-agents.ts";

/**
 * The running-agents strip's keyboard: which row the arrows land on, what `x` stops
 * or closes, and what Enter opens.
 *
 * Its own home because it is a keyboard rather than a render — the root paints the
 * strip, this decides what a press does to it — and because the focus it tracks is
 * state the root has no other reason to hold.
 */

/** The one visible-strip list every navigation/action reader shares. */
export function panelAgentsForView(): BackgroundTask[] {
  const viewingId = appStore.getState().view.viewingAgentId ?? undefined;
  return visiblePanelAgents(listBackgroundTasks(), viewingId);
}

/** ctrl+x ctrl+k: every live agent run in the session stops. Shells are not agents
 * and keep running — the hint promises agents and nothing else. */
export function stopAllRunningAgents(): void {
  clearStopConfirm();
  for (const task of listBackgroundTasks()) {
    if (task.kind === "agent" && task.status === "running") stopTaskForUser(task);
  }
  realignPanelFocus();
}

export function navigateBackgroundRows(direction: "up" | "down"): boolean {
  const tasks = listBackgroundTasks();
  const agents = panelAgentsForView();
  const workflows = activeWorkflows();
  const view = appStore.getState().view;
  // The main row leads the list whenever there is an agent to leave behind — one still
  // listed, or the one whose document is open. It is what the reader steers back to.
  const hasMainRow = agents.length > 0 || view.viewingAgentId !== null;
  const panelMaxIndex = hasMainRow ? agents.length + workflows.length : workflows.length - 1;
  const state = {
    hasShellPill: bgPillLabelFor(tasks.filter((task) => task.kind === "shell")) !== undefined,
    panelHasRows: hasMainRow || workflows.length > 0,
    bgPillFocused: view.bgPillFocused,
    panelFocused: view.panelFocused,
    panelSelection: view.panelSelection,
    panelMaxIndex,
  };
  const action =
    direction === "down" ? nextBackgroundFocusDown(state) : nextBackgroundFocusUp(state);
  if (action === "none") return false;
  // An armed confirmation belongs to the row the cursor was on; leaving it disarms.
  clearStopConfirm();
  BACKGROUND_FOCUS_MOVES[action](state);
  return true;
}

/** One writer per focus move, so the decision stays in `background-focus.ts`. */
const BACKGROUND_FOCUS_MOVES: Record<
  Exclude<BackgroundFocusAction, "none">,
  (state: BackgroundFocusState) => void
> = {
  "focus-shell-pill": () => {
    dispatch({ type: "view/setPanelFocused", focused: false });
    dispatch({ type: "view/setBgPillFocused", focused: true });
  },
  "blur-shell-pill": () => {
    dispatch({ type: "view/setBgPillFocused", focused: false });
  },
  "focus-panel-first": () => {
    dispatch({ type: "view/setBgPillFocused", focused: false });
    dispatch({ type: "view/setPanelFocused", focused: true });
    dispatch({ type: "view/setPanelSelection", value: 0 });
  },
  "next-panel-row": (state) => {
    dispatch({
      type: "view/setPanelSelection",
      value: Math.min(state.panelMaxIndex, state.panelSelection + 1),
    });
  },
  "previous-panel-row": (state) => {
    dispatch({
      type: "view/setPanelSelection",
      value: Math.max(0, state.panelSelection - 1),
    });
  },
  "blur-panel": () => {
    dispatch({ type: "view/setPanelFocused", focused: false });
  },
};

/**
 * The stop key on the focused row is a two-stage gesture for agents: the first
 * press stops a live run (the tree, resumable from its document) and arms the
 * row; the second press within the hold closes the row — task and subtree leave
 * the store. Workflows keep the single-press abort.
 */
export function stopOrCloseBackgroundSelection(): boolean {
  const view = appStore.getState().view;
  const agents = panelAgentsForView();
  const hasMainRow = agents.length > 0 || view.viewingAgentId !== null;
  if (hasMainRow && view.panelSelection === 0) return false;
  const agent = hasMainRow ? agents[view.panelSelection - 1] : undefined;
  if (agent !== undefined) {
    if (armedStopTaskId() === agent.id) {
      clearStopConfirm();
      if (view.viewingAgentId === agent.id) dispatch({ type: "view/setViewingAgent", id: null });
      removeTaskTree(agent.id);
      // The task emit is throttled; the gesture realigns now so the cursor
      // never spends the throttle window on a row that no longer exists.
      realignPanelFocus();
      return true;
    }
    // Arm before stopping: the stop emits synchronously and the reactive
    // realign must already see the armed row, or the strip would drop it —
    // and the focus — in the middle of the gesture.
    const live = agent.status === "running";
    armStopConfirm(agent.id, live);
    if (live) stopTaskForUser(agent);
    return true;
  }
  const workflowIndex = view.panelSelection - (hasMainRow ? agents.length + 1 : 0);
  const workflow = activeWorkflows()[workflowIndex];
  return workflow !== undefined ? killWorkflowTask(workflow.id, true) : false;
}

/**
 * Panel rows shrink under the cursor — a close, a finished run, an eviction, an
 * expired confirmation. With none left the focus returns to the prompt — panel
 * focus over an empty strip swallows every printable key — and with fewer rows
 * the selection clamps so the cursor never points past them. An armed row whose
 * task left the store disarms with it.
 */
let lastPanelRowKeys: string[] = [];

/** Seeds the remembered rows at mount, so the first realign has a previous to compare. */
export function setPanelRowKeys(keys: string[]): void {
  lastPanelRowKeys = keys;
}

export function panelRowKeysForView(): string[] {
  const view = appStore.getState().view;
  const agents = panelAgentsForView();
  const workflows = activeWorkflows();
  const hasMainRow = agents.length > 0 || view.viewingAgentId !== null;
  return [
    ...(hasMainRow ? ["main"] : []),
    ...agents.map((task) => `agent:${task.id}`),
    ...workflows.map((task) => `workflow:${task.id}`),
  ];
}

export function realignPanelFocus(): void {
  const armedId = armedStopTaskId();
  if (armedId !== null && getBackgroundTask(armedId) === undefined) clearStopConfirm();
  const view = appStore.getState().view;
  const previousKeys = lastPanelRowKeys;
  const nextKeys = panelRowKeysForView();
  lastPanelRowKeys = nextKeys;
  if (!view.panelFocused) return;
  if (nextKeys.length === 0) {
    dispatch({ type: "view/setPanelFocused", focused: false });
    return;
  }
  // Selection follows rows, not positions: when either namespace changes (a
  // document opened its subtree, a run left), the cursor stays with the row it
  // was on if that row survives, else the nearest earlier survivor, else main.
  const listChanged =
    previousKeys.length !== nextKeys.length ||
    previousKeys.some((key, index) => key !== nextKeys[index]);
  if (listChanged && view.panelSelection < previousKeys.length) {
    for (let index = view.panelSelection; index >= 0; index -= 1) {
      const nextIndex = nextKeys.indexOf(previousKeys[index]!);
      if (nextIndex !== -1) {
        if (view.panelSelection !== nextIndex) {
          dispatch({ type: "view/setPanelSelection", value: nextIndex });
        }
        return;
      }
    }
    dispatch({ type: "view/setPanelSelection", value: 0 });
    return;
  }
  const maxIndex = nextKeys.length - 1;
  if (view.panelSelection > maxIndex) {
    dispatch({ type: "view/setPanelSelection", value: Math.max(0, maxIndex) });
  }
}

export function activateBackgroundSelection(): boolean {
  const view = appStore.getState().view;
  if (view.bgPillFocused) {
    dispatch({ type: "view/setBgPillFocused", focused: false });
    overlayStack.open("tasks");
    return true;
  }
  if (!view.panelFocused) return false;
  const agents = panelAgentsForView();
  // The main row is offered whenever there is an agent to leave — one still listed, or
  // the one being read after its work ended. Without it a finished agent's document
  // would be a room with no door.
  const hasMainRow = agents.length > 0 || view.viewingAgentId !== null;
  if (hasMainRow) {
    // Selecting main swaps the document back but the reader stays on the rows:
    // dropping them at the prompt would make every return trip re-navigate.
    if (view.panelSelection === 0) {
      dispatch({ type: "view/setViewingAgent", id: null });
      realignPanelFocus();
      return true;
    }
    const agent = agents[view.panelSelection - 1];
    if (agent !== undefined) {
      dispatch({ type: "view/setViewingAgent", id: agent.id });
      // Opening a document reshapes the tree (its subtree unfolds); the cursor
      // must land on the same row in the reshaped list before the next paint.
      realignPanelFocus();
      return true;
    }
  }
  const workflowIndex = view.panelSelection - (hasMainRow ? agents.length + 1 : 0);
  const workflow = activeWorkflows()[workflowIndex];
  if (workflow !== undefined) {
    dispatch({ type: "view/setWorkflowDetailTarget", id: workflow.id });
    dispatch({ type: "view/setPanelFocused", focused: false });
    overlayStack.open("workflows");
    return true;
  }
  // Nothing here answers to the key. The rows this focus was given to are gone — the
  // work they stood for ended — so the focus goes back to the prompt rather than
  // swallowing every keystroke aimed at it.
  dispatch({ type: "view/setPanelFocused", focused: false });
  return false;
}
