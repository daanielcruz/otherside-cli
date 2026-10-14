import { stringifyForDisplay } from "@/kernel/std/text/json-display.ts";

export function formatToolInput(input: unknown): string {
  return stringifyForDisplay(input);
}

export function decodeTaskNoticeXml(value: string | undefined): string | undefined {
  return value
    ?.replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function taskNoticeTextFromNotification(content: string): string {
  const summary = decodeTaskNoticeXml(content.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim());
  return summary && summary.length > 0 ? summary : "Background task completed";
}

/** A notification no background task owns, so no completion row speaks for it. */
export function isUnownedNotification(content: string): boolean {
  return !/<task-id>/.test(content);
}

export function taskNotificationFromAttachment(attachment: unknown): string | null {
  if (!attachment || typeof attachment !== "object") return null;
  const obj = attachment as Record<string, unknown>;
  if (obj.type !== "queued_command") return null;
  if (obj.commandMode !== "task-notification") return null;
  return typeof obj.prompt === "string" ? obj.prompt : null;
}
