import { notify } from "@/design/bridge/envelope.ts";
import { scrub } from "@/design/bridge/scrubber.ts";
import { type LlmStreamInput, snapshotMessages } from "@/design/capabilities/stream-input.ts";
import { saveDesignSnapshot } from "@/design/storage.ts";
import {
  appendDesignText,
  currentDesignTextSegment,
  designToolPreview,
  flushDesignText,
  PREVIEWLESS_TOOLS,
  previewlessDonePreview,
  recordToolEnd,
  recordToolStart,
} from "@/design/tool-cards.ts";
import type { RpcContext } from "@/design/types.ts";
import type { SubagentResult } from "@/engine/background/subagents/dispatcher.ts";
import type { ForkEvent } from "@/kernel/std/types/events.ts";

function sendDeltaSafe(ctx: RpcContext, id: number, segment: number, text: string): boolean {
  const verdict = scrub(text);
  if (!verdict.ok) {
    ctx.emit(notify("$/error", { id, code: "internal_error" }));
    return false;
  }
  // `id` stays numeric (older clients require it); `segment` is an additive
  // field an older web ignores — it composes the bubble key from id + segment so
  // text runs split by a tool boundary render as distinct bubbles.
  ctx.emit(notify("$/delta", { id, segment, text }));
  return true;
}

export function setSnapshotMessages(ctx: RpcContext, parsed: LlmStreamInput): void {
  const snapshot = ctx.snapshots.get(parsed.designId);
  if (!snapshot) return;
  const next = {
    ...snapshot,
    messages: snapshotMessages(parsed.messages, snapshot),
    status: "streaming" as const,
    updatedAt: new Date().toISOString(),
  };
  ctx.snapshots.set(parsed.designId, next);
  saveDesignSnapshot(ctx.cwd, next);
}

export function completeSnapshot(
  ctx: RpcContext,
  designId: string,
  output: string,
  turnIndex: number,
): void {
  const snapshot = ctx.snapshots.get(designId);
  if (!snapshot) return;
  const updatedAt = new Date().toISOString();
  // The final text is the last iteration's output; interim prose ran before a
  // tool and is already persisted as its own segment. When the turn ends on a
  // tool (empty final text), skip the empty bubble — the segments carry it all.
  const finalMessage =
    output.trim().length > 0
      ? [
          {
            id: `design-assistant-${updatedAt}`,
            role: "assistant" as const,
            content: output,
            // Completion time, not turn start: the reply must sort after the user
            // message and the turn's tool cards on rehydrate.
            createdAt: updatedAt,
            source: "left" as const,
            status: "done" as const,
            turnIndex,
          },
        ]
      : [];
  const next = {
    ...snapshot,
    messages: [...snapshot.messages, ...finalMessage],
    status: "completed" as const,
    updatedAt,
  };
  ctx.snapshots.set(designId, next);
  saveDesignSnapshot(ctx.cwd, next);
}

export function emitForkEvent(
  ctx: RpcContext,
  streamId: number,
  event: ForkEvent,
  designId: string,
): void {
  if (event.kind === "fork_text_delta") {
    appendDesignText(designId, event.text);
    sendDeltaSafe(ctx, streamId, currentDesignTextSegment(designId), event.text);
    return;
  }
  if (event.kind === "fork_tool_dispatch_start") {
    // The buffered text ran before this tool — flush it as its own message so it
    // keeps its place ahead of the card (and opens a fresh segment for what follows).
    flushDesignText(ctx, designId);
    recordToolStart(ctx, designId, event.toolCallId, event.toolName, event.input, "main");
    // Authored HTML is large and never rendered in the pill — the HTML-authoring
    // tools ship only a tiny { path?, title? } descriptor instead of their input.
    const preview = designToolPreview(event.toolName, event.input);
    ctx.emit(
      notify("$/tool", {
        id: event.toolCallId,
        name: event.toolName,
        phase: "running",
        lane: "main",
        ...(preview !== undefined ? { preview } : {}),
      }),
    );
    return;
  }
  if (event.kind === "fork_tool_dispatch_complete") {
    recordToolEnd(
      ctx,
      designId,
      event.toolCallId,
      event.toolName,
      event.isError,
      event.content,
      "main",
    );
    const preview = PREVIEWLESS_TOOLS.has(event.toolName)
      ? previewlessDonePreview(event.isError ? undefined : event.content)
      : event.content;
    ctx.emit(
      notify("$/tool", {
        id: event.toolCallId,
        name: event.toolName,
        phase: event.isError ? "error" : "done",
        lane: "main",
        ...(preview !== undefined ? { preview } : {}),
      }),
    );
    return;
  }
  if (event.kind === "fork_quota_exhausted") {
    ctx.emit(
      notify("$/error", {
        id: streamId,
        code: "quota_exhausted",
        rateLimit: event.message,
      }),
    );
  }
}

export function designTurnFailureMessage(
  result: Pick<SubagentResult, "output" | "quotaExhausted">,
  provider: string,
  model: string,
): string {
  const quota = result.quotaExhausted;
  if (quota !== undefined) {
    return `Provider usage limit reached (${quota.provider}/${quota.model}). Switch the model in the CLI or wait for the limit to reset.`;
  }
  const output = result.output.trim();
  if (/^stalled — no progress for \d+ms$/.test(output)) return output;
  return `The model stream failed (${provider}/${model}). Try again.`;
}
