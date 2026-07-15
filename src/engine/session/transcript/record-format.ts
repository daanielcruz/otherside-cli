import { stringifyForDisplay } from "@/kernel/std/text/json-display.ts";

export function formatToolInput(input: unknown): string {
  return stringifyForDisplay(input);
}

export function taskNotificationFromAttachment(attachment: unknown): string | null {
  if (!attachment || typeof attachment !== "object") return null;
  const obj = attachment as Record<string, unknown>;
  if (obj.type !== "queued_command") return null;
  if (obj.commandMode !== "task-notification") return null;
  return typeof obj.prompt === "string" ? obj.prompt : null;
}
