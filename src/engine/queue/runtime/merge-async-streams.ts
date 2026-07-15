import { AsyncStream } from "@/kernel/std/stream/async.ts";
import type { AgentEvent } from "@/kernel/std/types/events.ts";

interface MergeSource {
  queue: AsyncStream<AgentEvent>;
  isDone: () => boolean;
}

interface MergeResult {
  merged: AsyncStream<AgentEvent>;
  done: Promise<unknown>;
  isDrained: () => boolean;
}

export function mergeAsyncStreams({ sources }: { sources: MergeSource[] }): MergeResult {
  const merged = new AsyncStream<AgentEvent>();
  let pumpsRemaining = sources.length;
  const pumps = sources.map((source) =>
    (async () => {
      for await (const event of source.queue.iterate(source.isDone)) merged.push(event);
    })().finally(() => {
      pumpsRemaining -= 1;
      merged.signal();
    }),
  );
  return {
    merged,
    done: Promise.allSettled(pumps),
    isDrained: () => pumpsRemaining === 0,
  };
}
