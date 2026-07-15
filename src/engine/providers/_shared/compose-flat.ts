import type { ComposedHarness } from "@/harness/composer/injections.ts";
import type { Message } from "@/kernel/std/types/message.ts";

export function composeFlatMessages(harness: ComposedHarness, history: Message[]): Message[] {
  if (harness.combined.length === 0) return history;
  return [{ role: "system", content: [{ type: "text", text: harness.combined }] }, ...history];
}
