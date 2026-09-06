import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import type {
  AssistantMessageRecord,
  SessionRecord,
  UsageRecord,
  UserMessageRecord,
} from "./record/schema.ts";

/**
 * A resumed large transcript materializes only its tail. The history behind that
 * tail still has to answer three questions — what it spent, how full the context
 * was when it stopped, and which route was in force — and the answers are a
 * handful of facts rather than one record per line.
 *
 * The three carriers below are deliberately separate because the scans that read
 * them stop at different records:
 *
 * - A ROLLUP carries the summed spend. It is a `usage` record with `rollup` set,
 *   which keeps it out of the context scan (that scan reads bare `usage` records
 *   only when they are estimates) while the spend totals still fold it in.
 * - The LAST usage-bearing assistant line survives verbatim, so the context scan
 *   walking back from the tail finds a real snapshot instead of a sum. Its spend
 *   is excluded from the rollup, so the two never double-count.
 * - The LAST user line survives verbatim, so the permission mode and route it
 *   stamped still reach the broker restore.
 *
 * Keeping one line of each kind is also what lets a resumed session still read as
 * having a conversation: a gate asking whether any message record exists would
 * otherwise answer no for history that plainly happened.
 */

/** Records a discarded region contributes, in transcript order. */
export interface DiscardedHistoryAggregate {
  records: SessionRecord[];
}

interface RouteSpend {
  provider: ProviderId | undefined;
  model: string | undefined;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  requestCount: number;
  firstTs: string;
  /** Held back from the sum above; it is emitted whole so the context scan reads it. */
  lastUsageLine: AssistantMessageRecord | null;
}

function routeKey(provider: string | undefined, model: string | undefined): string {
  return `${provider ?? ""}\u0000${model ?? ""}`;
}

function foldAssistantSpend(spend: RouteSpend, record: AssistantMessageRecord): void {
  const previous = spend.lastUsageLine;
  spend.lastUsageLine = record;
  if (previous === null) return;
  // The line just displaced was the newest until now, so its spend joins the sum.
  const usage = previous.usage;
  if (!usage) return;
  spend.inputTokens += usage.input_tokens;
  spend.outputTokens += usage.output_tokens;
  spend.thoughtTokens += usage.thought_tokens;
  spend.cacheCreationInputTokens += usage.cache_creation_input_tokens;
  spend.cacheReadInputTokens += usage.cache_read_input_tokens;
  spend.requestCount += usage.request_count;
}

function rollupRecord(spend: RouteSpend, sessionId: string): UsageRecord | null {
  const empty =
    spend.inputTokens === 0 &&
    spend.outputTokens === 0 &&
    spend.thoughtTokens === 0 &&
    spend.cacheCreationInputTokens === 0 &&
    spend.cacheReadInputTokens === 0 &&
    spend.requestCount === 0;
  if (empty) return null;
  if (spend.provider === undefined) return null;
  return {
    type: "usage",
    ts: spend.firstTs,
    provider: spend.provider,
    model: spend.model ?? "",
    session_id: sessionId,
    request_count: spend.requestCount,
    input_tokens: spend.inputTokens,
    output_tokens: spend.outputTokens,
    thought_tokens: spend.thoughtTokens,
    cache_creation_input_tokens: spend.cacheCreationInputTokens,
    cache_read_input_tokens: spend.cacheReadInputTokens,
    rollup: true,
  };
}

/**
 * Collapses the per-line message stubs of a discarded region into the facts that
 * region still owes. Every other record type is returned untouched and in order —
 * compaction marks, attachments, injections and meta lines are what the rest of
 * the resume path reads, and none of them is summarizable.
 */
export function aggregateDiscardedHistory(
  records: readonly SessionRecord[],
  sessionId: string,
): DiscardedHistoryAggregate {
  const kept: SessionRecord[] = [];
  const spendByRoute = new Map<string, RouteSpend>();
  let lastUserLine: UserMessageRecord | null = null;

  for (const record of records) {
    if (record.type === "user_message") {
      lastUserLine = record;
      continue;
    }
    if (record.type !== "assistant_message") {
      kept.push(record);
      continue;
    }
    const assistant = record;
    const key = routeKey(assistant.provider, assistant.model);
    let spend = spendByRoute.get(key);
    if (spend === undefined) {
      spend = {
        provider: assistant.provider as ProviderId | undefined,
        model: assistant.model,
        inputTokens: 0,
        outputTokens: 0,
        thoughtTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        requestCount: 0,
        firstTs: assistant.ts,
        lastUsageLine: null,
      };
      spendByRoute.set(key, spend);
    }
    if (assistant.usage) foldAssistantSpend(spend, assistant);
    else if (spend.lastUsageLine === null) spend.lastUsageLine = assistant;
  }

  for (const spend of spendByRoute.values()) {
    const rollup = rollupRecord(spend, sessionId);
    if (rollup !== null) kept.push(rollup);
  }
  // Both survivors go last so a backward scan reaches them before any rollup, and
  // a forward broker restore ends on the route the history actually left behind.
  for (const spend of spendByRoute.values()) {
    if (spend.lastUsageLine !== null) kept.push(spend.lastUsageLine);
  }
  if (lastUserLine !== null) kept.push(lastUserLine);

  return { records: kept };
}
