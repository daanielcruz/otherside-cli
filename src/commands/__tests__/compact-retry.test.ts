import { describe, expect, it } from "bun:test";
import type { SlashCommand } from "@/commands/catalog.ts";
import { handleCompact } from "@/commands/handlers/compact.ts";
import type { SlashContext } from "@/commands/types.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";

const COMPACT: SlashCommand = { name: "compact", kind: "anchor", description: "" } as SlashCommand;

function runCompact(events: ProviderEvent[]): string[] {
  const calls: string[] = [];
  const ctx = {
    agent: {
      forceCompact: async (opts: { onEvent?: (ev: ProviderEvent) => void }) => {
        for (const ev of events) opts.onEvent?.(ev);
        return { dropped: 0, summary: "", durationMs: 0, truncated: 0 };
      },
    },
    onCompactRetry: (attempt: number) => calls.push(`retry ${attempt}`),
    onCompactRetrySettled: () => calls.push("settled"),
    onCompactProgress: () => calls.push("progress"),
  } as unknown as SlashContext;
  void handleCompact(COMPACT, "", ctx);
  return calls;
}

const retry: ProviderEvent = {
  kind: "retry_status",
  attempt: 1,
  maxAttempts: 10,
  delayMs: 0,
  reason: "dropped stale thinking replay",
};

describe("/compact retry status", () => {
  it("settles the retry once the summary stream answers again", () => {
    expect(runCompact([retry, { kind: "text_delta", text: "summary" }])).toEqual([
      "retry 1",
      "settled",
      "progress",
    ]);
  });

  it("never settles a compaction that did not retry", () => {
    expect(runCompact([{ kind: "text_delta", text: "summary" }])).toEqual(["progress"]);
  });
});
