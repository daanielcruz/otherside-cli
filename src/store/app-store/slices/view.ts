import type { UsageWarning } from "@/engine/session/usage/limits.ts";
import type { ErrorMeta } from "@/engine/transport/error-meta.ts";
import type { RemoteSyncStatus } from "@/kernel/std/types/remote-sync-status.ts";
import type { SpinnerMode } from "@/kernel/std/types/spinner-mode.ts";
import type { AppAction } from "@/store/app-store/types.ts";

export type { RemoteSyncStatus, SpinnerMode };
export type ThinkingStatus = "thinking" | number | null;

export interface RetryStatusLine {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  startedAt: number;
  reason: string;
  status?: number;
  message?: string;
}

export interface ErrorPanelState {
  meta: ErrorMeta;
  attemptCount: number;
  rawExpanded: boolean;
}

export interface ViewSlice {
  readonly quotaPanel: true | null;
  readonly errorPanel: ErrorPanelState | null;
  readonly usageWarning: UsageWarning | null;
  readonly logEpoch: number;
  readonly retryStatus: RetryStatusLine | null;
  readonly viewingAgentId: string | null;
  readonly spinnerMode: SpinnerMode;
  readonly turnVerb: string;
  readonly thinkingStatus: ThinkingStatus;
  readonly remoteSyncStatus: RemoteSyncStatus;
  readonly isTurnRunning: boolean;
  readonly contextWarningSuppressed: boolean;
  readonly turnTipIndex: number | null;
  readonly panelFocus: string | null;
  readonly workflowDetailTargetId: string | null;
  readonly workflowDetailOpen: boolean;
  readonly btwMode: boolean;
  readonly bgPillFocused: boolean;
  readonly panelFocused: boolean;
  readonly panelSelection: number;
  readonly tasksExpanded: boolean;
  readonly bgTasksOpen: boolean;
  readonly configInitialTab: "details" | "config" | undefined;
  readonly busy: boolean;
  readonly progressStartedAt: number | null;
}

export const initialViewSlice: ViewSlice = {
  quotaPanel: null,
  errorPanel: null,
  usageWarning: null,
  logEpoch: 0,
  retryStatus: null,
  viewingAgentId: null,
  spinnerMode: "requesting",
  turnVerb: "Thinking",
  thinkingStatus: null,
  remoteSyncStatus: "disconnected",
  isTurnRunning: false,
  contextWarningSuppressed: false,
  turnTipIndex: null,
  panelFocus: null,
  workflowDetailTargetId: null,
  workflowDetailOpen: false,
  btwMode: false,
  bgPillFocused: false,
  panelFocused: false,
  panelSelection: 0,
  tasksExpanded: false,
  bgTasksOpen: false,
  configInitialTab: undefined,
  busy: false,
  progressStartedAt: null,
};

export function viewReducer(prev: ViewSlice, action: AppAction): ViewSlice {
  switch (action.type) {
    case "view/showQuota":
      return prev.quotaPanel === true ? prev : { ...prev, quotaPanel: true };
    case "view/hideQuota":
      return prev.quotaPanel === null ? prev : { ...prev, quotaPanel: null };
    case "view/showErrorPanel":
      return { ...prev, errorPanel: { meta: action.meta, attemptCount: 1, rawExpanded: false } };
    case "view/bumpErrorAttempt":
      return {
        ...prev,
        errorPanel: {
          meta: action.meta,
          attemptCount: (prev.errorPanel?.attemptCount ?? 1) + 1,
          rawExpanded: prev.errorPanel?.rawExpanded ?? false,
        },
      };
    case "view/toggleErrorRaw":
      return prev.errorPanel
        ? {
            ...prev,
            errorPanel: { ...prev.errorPanel, rawExpanded: !prev.errorPanel.rawExpanded },
          }
        : prev;
    case "view/hideErrorPanel":
      return prev.errorPanel === null ? prev : { ...prev, errorPanel: null };
    case "view/setUsageWarning":
      return prev.usageWarning === action.warning
        ? prev
        : { ...prev, usageWarning: action.warning };
    case "view/clearUsageWarningIfKey": {
      const current = prev.usageWarning;
      if (!current) return prev;
      if (`${current.severity}:${current.message}` !== action.key) return prev;
      return { ...prev, usageWarning: null };
    }
    case "view/bumpLogEpoch":
      return { ...prev, logEpoch: prev.logEpoch + 1 };
    case "view/setRetryStatus":
      return prev.retryStatus === action.status ? prev : { ...prev, retryStatus: action.status };
    case "view/setViewingAgent":
      return prev.viewingAgentId === action.id ? prev : { ...prev, viewingAgentId: action.id };
    case "view/setSpinnerMode":
      return prev.spinnerMode === action.mode ? prev : { ...prev, spinnerMode: action.mode };
    case "view/setTurnVerb":
      return prev.turnVerb === action.verb ? prev : { ...prev, turnVerb: action.verb };
    case "view/setThinkingStatus":
      return prev.thinkingStatus === action.status
        ? prev
        : { ...prev, thinkingStatus: action.status };
    case "view/setRemoteSyncStatus":
      return prev.remoteSyncStatus === action.status
        ? prev
        : { ...prev, remoteSyncStatus: action.status };
    case "view/setTurnRunning":
      return prev.isTurnRunning === action.running
        ? prev
        : { ...prev, isTurnRunning: action.running };
    case "view/setContextWarningSuppressed":
      return prev.contextWarningSuppressed === action.suppressed
        ? prev
        : { ...prev, contextWarningSuppressed: action.suppressed };
    case "view/setTurnTipIndex":
      return prev.turnTipIndex === action.index ? prev : { ...prev, turnTipIndex: action.index };
    case "view/setPanelFocus":
      return prev.panelFocus === action.focus ? prev : { ...prev, panelFocus: action.focus };
    case "view/setWorkflowDetailTarget":
      return prev.workflowDetailTargetId === action.id
        ? prev
        : { ...prev, workflowDetailTargetId: action.id };
    case "view/setWorkflowDetailOpen":
      return prev.workflowDetailOpen === action.open
        ? prev
        : { ...prev, workflowDetailOpen: action.open };
    case "view/setBtwMode":
      return prev.btwMode === action.active ? prev : { ...prev, btwMode: action.active };
    case "view/setBgPillFocused":
      return prev.bgPillFocused === action.focused
        ? prev
        : { ...prev, bgPillFocused: action.focused };
    case "view/setPanelFocused":
      return prev.panelFocused === action.focused
        ? prev
        : { ...prev, panelFocused: action.focused };
    case "view/setPanelSelection":
      return prev.panelSelection === action.value
        ? prev
        : { ...prev, panelSelection: action.value };
    case "view/setTasksExpanded":
      return prev.tasksExpanded === action.value ? prev : { ...prev, tasksExpanded: action.value };
    case "view/setBgTasksOpen":
      return prev.bgTasksOpen === action.open ? prev : { ...prev, bgTasksOpen: action.open };
    case "view/setConfigInitialTab":
      return prev.configInitialTab === action.tab
        ? prev
        : { ...prev, configInitialTab: action.tab };
    case "view/setBusy":
      return prev.busy === action.busy ? prev : { ...prev, busy: action.busy };
    case "view/setProgressStartedAt":
      return prev.progressStartedAt === action.startedAt
        ? prev
        : { ...prev, progressStartedAt: action.startedAt };
    default:
      return prev;
  }
}
