import { describe, expect, it } from "bun:test";
import type { NotificationCtx } from "@/kernel/hooks/events.ts";
import {
  armPermissionPromptNotification,
  PERMISSION_PROMPT_IDLE_MS,
  permissionPromptNotificationMessage,
} from "../prompt.tsx";

describe("permissionPromptNotificationMessage", () => {
  it("names the pending tool action", () => {
    expect(permissionPromptNotificationMessage({ toolName: "Bash" })).toBe(
      "Otherside needs your permission to use Bash",
    );
  });

  it("uses plan-specific wording for ExitPlanMode", () => {
    expect(permissionPromptNotificationMessage({ toolName: "ExitPlanMode" })).toBe(
      "Otherside needs your approval for the plan",
    );
  });

  it("falls back when the tool name is empty", () => {
    expect(permissionPromptNotificationMessage({ toolName: "" })).toBe(
      "Otherside needs your attention",
    );
  });

  it("strips mcp tool namespace for the displayed name", () => {
    expect(permissionPromptNotificationMessage({ toolName: "mcp__server__search" })).toBe(
      "Otherside needs your permission to use search",
    );
  });
});

describe("armPermissionPromptNotification", () => {
  it("fires Notification with permission_prompt after the idle timeout", async () => {
    const calls: NotificationCtx[] = [];
    const notification = armPermissionPromptNotification(
      { toolName: "Write" },
      (ctx) => calls.push(ctx),
      20,
    );

    expect(calls).toEqual([]);
    await Bun.sleep(35);
    expect(calls).toEqual([
      {
        hook_event_name: "Notification",
        message: "Otherside needs your permission to use Write",
        notification_type: "permission_prompt",
      },
    ]);
    notification.markInteraction();
    await Bun.sleep(25);
    expect(calls).toHaveLength(1);
    notification.cancel();
  });

  it("restarts the idle window when the user interacts", async () => {
    const calls: NotificationCtx[] = [];
    const notification = armPermissionPromptNotification(
      { toolName: "Read" },
      (ctx) => calls.push(ctx),
      40,
    );

    await Bun.sleep(25);
    notification.markInteraction();
    await Bun.sleep(25);
    expect(calls).toEqual([]);
    await Bun.sleep(25);
    expect(calls).toHaveLength(1);
    notification.cancel();
  });

  it("cancels the timer when the user decides early", async () => {
    const calls: NotificationCtx[] = [];
    const notification = armPermissionPromptNotification(
      { toolName: "Bash" },
      (ctx) => calls.push(ctx),
      30,
    );
    notification.cancel();
    await Bun.sleep(45);
    expect(calls).toEqual([]);
  });

  it("uses the reference 6s idle threshold by default", () => {
    expect(PERMISSION_PROMPT_IDLE_MS).toBe(6000);
  });
});
