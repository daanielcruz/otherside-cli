import type { CodexUsage } from "@/engine/providers/codex/usage.ts";
import type { UsageWarning } from "@/engine/session/usage/limits.ts";
import type { TokenTotals, UsageByProvider } from "@/engine/session/usage/provider.ts";
import type { ErrorMeta } from "@/engine/transport/error-meta.ts";
import type { RightRegionAction, RightRegionSlice } from "@/store/app-store/slices/right-region.ts";
import type { ContextUsageSnapshot, UsageSlice } from "@/store/app-store/slices/usage.ts";
import type {
  RemoteSyncStatus,
  RetryStatusLine,
  SpinnerMode,
  ThinkingStatus,
  ViewSlice,
} from "@/store/app-store/slices/view.ts";

export type EngineSlice = Readonly<Record<string, unknown>>;

export type AppState = {
  readonly engine: EngineSlice;
  readonly view: ViewSlice;
  readonly usage: UsageSlice;
  readonly rightRegion: RightRegionSlice;
};

export type AppAction =
  | RightRegionAction
  | { readonly type: "engine/setSlice"; readonly key: string; readonly value: unknown }
  | { readonly type: "view/showQuota" }
  | { readonly type: "view/hideQuota" }
  | { readonly type: "view/showErrorPanel"; readonly meta: ErrorMeta }
  | { readonly type: "view/bumpErrorAttempt"; readonly meta: ErrorMeta }
  | { readonly type: "view/toggleErrorRaw" }
  | { readonly type: "view/hideErrorPanel" }
  | { readonly type: "view/setUsageWarning"; readonly warning: UsageWarning | null }
  | { readonly type: "view/clearUsageWarningIfKey"; readonly key: string }
  | { readonly type: "view/bumpLogEpoch" }
  | { readonly type: "view/setRetryStatus"; readonly status: RetryStatusLine | null }
  | { readonly type: "view/setViewingAgent"; readonly id: string | null }
  | { readonly type: "view/toggleTranscriptScreen" }
  | { readonly type: "view/exitTranscriptScreen" }
  | { readonly type: "view/toggleAllTranscriptMessages" }
  | { readonly type: "view/setVerboseTranscript"; readonly verbose: boolean }
  | { readonly type: "view/setSpinnerMode"; readonly mode: SpinnerMode }
  | { readonly type: "view/setTurnVerb"; readonly verb: string }
  | { readonly type: "view/setThinkingStatus"; readonly status: ThinkingStatus }
  | { readonly type: "view/setRemoteSyncStatus"; readonly status: RemoteSyncStatus }
  | { readonly type: "view/setPluginStatusNotice"; readonly notice: string | null }
  | { readonly type: "view/setTurnRunning"; readonly running: boolean }
  | { readonly type: "view/setContextWarningSuppressed"; readonly suppressed: boolean }
  | { readonly type: "view/setTurnTipIndex"; readonly index: number | null }
  | { readonly type: "view/setPanelFocus"; readonly focus: string | null }
  | { readonly type: "view/setWorkflowDetailTarget"; readonly id: string | null }
  | { readonly type: "view/setWorkflowDetailOpen"; readonly open: boolean }
  | { readonly type: "view/setBgPillFocused"; readonly focused: boolean }
  | { readonly type: "view/setPanelFocused"; readonly focused: boolean }
  | { readonly type: "view/setPanelSelection"; readonly value: number }
  | { readonly type: "view/setTasksExpanded"; readonly value: boolean }
  | { readonly type: "view/setBgTasksOpen"; readonly open: boolean }
  | {
      readonly type: "view/setConfigInitialTab";
      readonly tab: "details" | "config" | undefined;
    }
  | { readonly type: "view/setBusy"; readonly busy: boolean }
  | { readonly type: "view/setProgressStartedAt"; readonly startedAt: number | null }
  | { readonly type: "usage/setByProvider"; readonly value: UsageByProvider }
  | {
      readonly type: "usage/updateByProvider";
      readonly updater: (prev: UsageByProvider) => UsageByProvider;
    }
  | { readonly type: "usage/setOfflineByProvider"; readonly value: UsageByProvider }
  | {
      readonly type: "usage/updateOfflineByProvider";
      readonly updater: (prev: UsageByProvider) => UsageByProvider;
    }
  | { readonly type: "usage/setCodex"; readonly value: CodexUsage | null }
  | { readonly type: "usage/setMainTotals"; readonly value: TokenTotals }
  | {
      readonly type: "usage/updateMainTotals";
      readonly updater: (prev: TokenTotals) => TokenTotals;
    }
  | { readonly type: "usage/setMainLastContext"; readonly value: ContextUsageSnapshot };

export type AppDispatch = (action: AppAction) => void;
