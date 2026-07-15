import type { BackgroundTask } from "@/engine/background/tasks/background.ts";
import type { ErrorActionId } from "@/engine/transport/error-meta.ts";
import type { ErrorPanelState } from "@/store/app-store/slices/view.ts";
import { dispatch, readPermissionQueueSlice, useAppSelect } from "@/store/index.ts";
import { AskQuestionOverlay, useAskQueueHead } from "@/ui/ask/index.ts";
import { BackgroundTasksOverlay } from "@/ui/panels/background-tasks";
import type { OverlayDispatchValue, OverlayStableValue } from "@/ui/panels/context";
import { ErrorPanel } from "@/ui/panels/error";
import { OverlayHost } from "@/ui/panels/host.tsx";
import { PermissionOverlay } from "@/ui/panels/permission/prompt";
import { QuotaOverlay } from "@/ui/panels/quota";
import type { OverlayOpenStack, OverlayRegistryProps } from "@/ui/panels/registry.tsx";

export interface LowerPanelSlotProps {
  quotaPanel: true | null;
  errorPanel: ErrorPanelState | null;
  bgTasksOpen: boolean;
  overlayOpenStack: OverlayOpenStack;
  bgTasks: readonly BackgroundTask[];
  overlayStable: OverlayStableValue;
  overlayDispatch: OverlayDispatchValue;
  overlayLegacyProps: OverlayRegistryProps;
  onOpenModel: () => void;
  onCloseBgTasks: () => void;
  onErrorAction: (id: ErrorActionId) => void;
}

function renderActivePanel({
  quotaPanel,
  errorPanel,
  bgTasksOpen,
  overlayOpenStack,
  bgTasks,
  overlayStable,
  overlayDispatch,
  overlayLegacyProps,
  onOpenModel,
  onCloseBgTasks,
  onErrorAction,
}: LowerPanelSlotProps): React.JSX.Element | null {
  if (quotaPanel) {
    return (
      <QuotaOverlay
        onSwitchModel={onOpenModel}
        onDismiss={() => dispatch({ type: "view/hideQuota" })}
      />
    );
  }
  if (errorPanel) {
    return (
      <ErrorPanel
        meta={errorPanel.meta}
        attemptCount={errorPanel.attemptCount}
        rawExpanded={errorPanel.rawExpanded}
        onAction={onErrorAction}
        onToggleRaw={() => dispatch({ type: "view/toggleErrorRaw" })}
        onDismiss={() => onErrorAction("cancel")}
      />
    );
  }
  if (bgTasksOpen) {
    return (
      <BackgroundTasksOverlay
        tasks={bgTasks.filter((t) => t.isBackgrounded && t.status === "running")}
        onClose={onCloseBgTasks}
      />
    );
  }
  if (overlayOpenStack.length > 0) {
    return (
      <OverlayHost
        overlayOpenStack={overlayOpenStack}
        stable={overlayStable}
        dispatch={overlayDispatch}
        legacyProps={overlayLegacyProps}
      />
    );
  }
  return null;
}

export function LowerPanelSlot(props: LowerPanelSlotProps): React.JSX.Element | null {
  const hasPendingPermission = useAppSelect(
    (s) => (readPermissionQueueSlice(s.engine)?.[0] ?? null) !== null,
  );
  const askGroup = useAskQueueHead();

  if (hasPendingPermission) return <PermissionOverlay />;
  if (askGroup) return <AskQuestionOverlay />;
  return renderActivePanel(props);
}
