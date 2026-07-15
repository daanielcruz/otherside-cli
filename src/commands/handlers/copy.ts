import type { SlashCommand } from "@/commands/catalog.ts";
import type { SlashContext, SlashResult } from "@/commands/types.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import { writeTextToClipboard } from "@/ui/input/paste/clipboard.ts";

export async function handleCopy(
  cmd: SlashCommand,
  args: string,
  ctx: SlashContext,
): Promise<SlashResult> {
  const trimmed = args.trim();
  let nth = 1;
  if (trimmed.length > 0) {
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return { kind: "instant", command: cmd, feedback: `Invalid argument: ${trimmed}` };
    }
    nth = parsed;
  }
  const text = collectAssistantText(ctx.session.messages, nth);
  if (!text) return { kind: "instant", command: cmd, feedback: "Nothing to copy" };
  const ok = await writeTextToClipboard(text);
  if (!ok) return { kind: "instant", command: cmd, feedback: "Clipboard write failed" };
  return { kind: "instant", command: cmd, feedback: "Copied to clipboard" };
}

function collectAssistantText(messages: Message[], nth: number): string {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const parts: string[] = [];
    for (const block of msg.content) {
      if (block.type === "text" && block.text.length > 0) parts.push(block.text);
    }
    if (parts.length === 0) continue;
    seen++;
    if (seen === nth) return parts.join("\n\n");
  }
  return "";
}
