import { fireNotificationHook } from "@/engine/queue/emit.ts";
import { userFacingToolName } from "@/engine/tools/tool-label.ts";
import type { PendingPermission } from "@/kernel/channels/permission.ts";
import type { NotificationCtx } from "@/kernel/hooks/events.ts";

/** Idle threshold before a permission request sends a notification hook. */
export const PERMISSION_PROMPT_IDLE_MS = 6000;

export function permissionPromptNotificationMessage(
  pending: Pick<PendingPermission, "toolName">,
): string {
  if (pending.toolName === "ExitPlanMode") {
    return "Otherside needs your approval for the plan";
  }
  const toolName = userFacingToolName(pending.toolName);
  if (toolName.trim().length === 0) return "Otherside needs your attention";
  return `Otherside needs your permission to use ${toolName}`;
}

/** Creates an idle notification that user interaction can re-arm. */
export function armPermissionPromptNotification(
  pending: Pick<PendingPermission, "toolName">,
  fire: (ctx: NotificationCtx) => void = fireNotificationHook,
  timeoutMs = PERMISSION_PROMPT_IDLE_MS,
): { cancel: () => void; markInteraction: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  let notified = false;

  const arm = (): void => {
    if (cancelled || notified) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (cancelled) return;
      notified = true;
      fire({
        hook_event_name: "Notification",
        message: permissionPromptNotificationMessage(pending),
        notification_type: "permission_prompt",
      });
    }, timeoutMs);
  };

  arm();
  return {
    cancel: () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    markInteraction: arm,
  };
}
