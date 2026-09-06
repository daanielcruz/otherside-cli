import { getWorkflowTaskByParentToolCallId } from "@/engine/background/workflows/runtime/store/store.ts";
import { isInterruptionMessage } from "@/engine/queue/runtime/interruption-text.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import { get as getToolHandler } from "@/engine/tools/registry.ts";
import { isProviderId } from "@/kernel/std/types/provider-ids.ts";
import { agentChipFromEvent } from "@/ui/transcript/agent-chip-data.ts";
import type { ToolEntryData } from "@/ui/transcript/string-view-tool.ts";
import { resolveToolLabel } from "@/ui/transcript/tool-render/label.ts";
import {
  payloadFromError,
  payloadFromMeta,
  payloadFromResult,
} from "@/ui/transcript/tool-render/payload.ts";
import type { ToolPayload, ToolStatus } from "@/ui/transcript/tool-render/types.ts";

export interface ToolMeta {
  name: string;
  callId: string;
  phase: "running" | "complete";
  input: unknown;
}

export function parseJsonInput(source: string): unknown {
  if (!source.startsWith("{") && !source.startsWith("[")) return null;
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

export function parseToolMeta(entry: TranscriptEntry): ToolMeta {
  const name = entry.title ?? "tool";
  const isComplete = entry.id.startsWith("r_");
  const callId = entry.id.replace(/^[a-z]+_/, "");
  const input = parseJsonInput(entry.input ?? entry.text);
  return { name, callId, phase: isComplete ? "complete" : "running", input };
}

export function toolRenderStatus(meta: ToolMeta, entry: TranscriptEntry): ToolStatus {
  if (meta.phase === "running") {
    if (entry.startedAt === undefined) return "queued";
    return "running";
  }
  if (entry.isError) return "error";
  return "ok";
}

export interface CompleteToolPayloadInput {
  meta: ToolMeta;
  entry: TranscriptEntry;
  toolText: string;
  metaPayload: ToolPayload | null;
}

export function completeToolPayload(input: CompleteToolPayloadInput): ToolPayload | null {
  const { meta, entry, toolText, metaPayload } = input;
  if (isInterruptionMessage(toolText)) return { kind: "interrupt" as const };
  if (metaPayload) return metaPayload;
  if (toolText.length === 0) return null;
  if (entry.isError) {
    return (
      payloadFromResult({
        name: meta.name,
        content: toolText,
        args: meta.input,
        isError: true,
      }) ?? payloadFromError(toolText)
    );
  }
  return payloadFromResult({ name: meta.name, content: toolText, args: meta.input });
}

export interface ResolveToolPayloadInput extends CompleteToolPayloadInput {
  workflowPayload: ToolPayload | null;
}

export function resolveToolPayload(input: ResolveToolPayloadInput): ToolPayload | null {
  const { meta, entry, workflowPayload } = input;
  if (workflowPayload) return workflowPayload;
  if (meta.phase === "complete") return completeToolPayload(input);
  if (entry.liveOutput) return { kind: "progress" as const, text: entry.liveOutput };
  return null;
}

export function workflowStatusPayload({
  name,
  callId,
  isError,
}: {
  name: string;
  callId: string;
  isError: boolean;
}): ToolPayload | null {
  if (name !== "Workflow") return null;
  if (isError) return null;
  const task = getWorkflowTaskByParentToolCallId(callId);
  if (!task) return null;
  return { kind: "workflow", task };
}

export function buildToolEntryData(entry: TranscriptEntry): ToolEntryData | null {
  const meta = parseToolMeta(entry);
  const hooks = getToolHandler(meta.name)?.render;
  if (hooks?.isTransparent?.(meta.input)) return null;
  const effectiveName = resolveToolLabel({
    name: meta.name,
    args: meta.input,
    mcpIdentity: entry.mcpIdentity,
  });
  if (effectiveName === "") return null;

  const toolText = hooks?.formatResult?.(entry.text, meta.input) ?? entry.text;
  const workflowPayload = workflowStatusPayload({
    name: meta.name,
    callId: meta.callId,
    isError: entry.isError ?? false,
  });
  const metaPayload =
    meta.phase === "complete" && entry.resultMeta ? payloadFromMeta(entry.resultMeta) : null;
  const payload = resolveToolPayload({
    meta,
    entry,
    toolText,
    metaPayload,
    workflowPayload,
  });
  const status = toolRenderStatus(meta, entry);
  const elapsedMs =
    status === "running" && entry.startedAt !== undefined
      ? Math.max(0, Date.now() - entry.startedAt)
      : undefined;
  const completion =
    meta.phase === "complete" && entry.isBackgrounded !== true
      ? agentChipFromEvent({
          kind: "tool_dispatch_complete",
          id: meta.callId,
          name: meta.name,
          content: entry.text,
          isError: entry.isError ?? false,
        })
      : null;
  const agentRoute =
    entry.agentRoute ??
    (entry.agentProvider && entry.agentModel
      ? { provider: entry.agentProvider, model: entry.agentModel }
      : undefined);
  const producedRoute =
    entry.producedRoute ??
    (entry.producedBy && entry.producedModel && isProviderId(entry.producedBy)
      ? { provider: entry.producedBy, model: entry.producedModel }
      : undefined);
  const completionChip = completion
    ? {
        ...completion.chip,
        ...(agentRoute
          ? { model: agentRoute.model, modelRoute: agentRoute }
          : entry.agentModel
            ? { model: entry.agentModel }
            : {}),
        ...(producedRoute
          ? { producedModel: producedRoute.model, producedRoute }
          : entry.producedModel
            ? { producedModel: entry.producedModel }
            : {}),
      }
    : null;
  return {
    name: meta.name,
    args: meta.input,
    ...(entry.mcpIdentity ? { mcpIdentity: entry.mcpIdentity } : {}),
    status,
    payload,
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    completionChip,
    nested: entry.nested ?? [],
    isBackgrounded: entry.isBackgrounded === true,
  };
}
