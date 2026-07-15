import { useState } from "react";
import { getWorkflowTaskByParentToolCallId } from "@/engine/background/workflows/runtime/store/store.ts";
import { isInterruptionMessage } from "@/engine/queue/runtime/interruption-text.ts";
import { get as getToolHandler } from "@/engine/tools/registry.ts";
import { Box } from "@/ink";
import { useSharedIntervalTick } from "@/ui/transcript/message-shared.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";
import { AgentChip, agentChipFromEvent } from "./agent-bridge.tsx";
import {
  displayModelName,
  displayNameFor,
  payloadFromError,
  payloadFromMeta,
  payloadFromResult,
  type ToolPayload,
  ToolRender,
  type ToolStatus,
} from "./tool-render/index.tsx";

interface ToolMeta {
  name: string;
  callId: string;
  phase: "running" | "complete";
  input: unknown;
}

function parseToolMeta(entry: TranscriptEntry): ToolMeta {
  const name = entry.title ?? "tool";
  const isComplete = entry.id.startsWith("r_");
  const callId = entry.id.replace(/^[a-z]+_/, "");
  const source = entry.input ?? entry.text;
  let input: unknown = null;
  if (source.startsWith("{") || source.startsWith("[")) {
    try {
      input = JSON.parse(source);
    } catch {}
  }
  return { name, callId, phase: isComplete ? "complete" : "running", input };
}

function toolRenderStatus(meta: ToolMeta, entry: TranscriptEntry): ToolStatus {
  if (meta.phase === "running") {
    if (entry.startedAt === undefined) return "queued";
    return "running";
  }
  if (entry.isError) return "error";
  return "ok";
}

function completeToolPayload(
  meta: ToolMeta,
  entry: TranscriptEntry,
  toolText: string,
  metaPayload: ToolPayload | null,
): ToolPayload | null {
  if (isInterruptionMessage(toolText)) return { kind: "interrupt" as const };
  if (metaPayload) return metaPayload;
  if (toolText.length === 0) return null;
  if (entry.isError) {
    return payloadFromResult(meta.name, toolText, meta.input, true) ?? payloadFromError(toolText);
  }
  return payloadFromResult(meta.name, toolText, meta.input);
}

function resolveToolPayload(
  meta: ToolMeta,
  entry: TranscriptEntry,
  toolText: string,
  metaPayload: ToolPayload | null,
  workflowPayload: ToolPayload | null,
): ToolPayload | null {
  if (workflowPayload) return workflowPayload;
  if (meta.phase === "complete") return completeToolPayload(meta, entry, toolText, metaPayload);
  if (entry.liveOutput) return { kind: "progress" as const, text: entry.liveOutput };
  return null;
}

function workflowStatusPayload({
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

export function ToolEntryRow({
  entry,
  providerShortKey,
  currentModel,
}: {
  entry: TranscriptEntry;
  providerShortKey: string;
  currentModel?: string;
}): React.JSX.Element | null {
  const meta = parseToolMeta(entry);
  // A running Agent row keeps the per-second heartbeat only once it has live
  // content (a nested tool has emitted progress into liveOutput) — the pure-init
  // phase stays static (no ticking Initializing…). Without the heartbeat the row
  // falls out of the render/flush loop and the engine-baked nested elapsed
  // (`(Ns · … )`) sticks at its first emit even though the store updates ~1×/s.
  // Backgrounded rows render a static label, so they never tick.
  const isRunning =
    meta.phase === "running" &&
    entry.startedAt !== undefined &&
    entry.isBackgrounded !== true &&
    (meta.name !== "Agent" || entry.liveOutput !== undefined);
  const [, setTick] = useState(0);
  useSharedIntervalTick(() => setTick((n) => n + 1), isRunning ? 1000 : null);

  const hooks = getToolHandler(meta.name)?.render;
  if (hooks?.isTransparent?.(meta.input)) return null;
  const effectiveName =
    hooks?.userFacingName?.(meta.input) ?? displayNameFor(meta.name, meta.input);
  if (effectiveName === "") return null;
  // A backgrounded row freezes as-is; its completion arrives only as the
  // separate notification chip — mutating the old row would double-report.
  if (
    (meta.name === "Agent" || meta.name === "Bash") &&
    meta.phase === "complete" &&
    entry.isBackgrounded !== true
  ) {
    const chip = agentChipFromEvent({
      kind: "tool_dispatch_complete",
      id: meta.callId,
      name: meta.name,
      content: entry.text,
      isError: entry.isError ?? false,
    });
    if (chip && chip.chip.kind !== "backgrounded") {
      const nextChip = {
        ...chip.chip,
        ...(entry.agentModel ? { model: entry.agentModel } : {}),
        ...(entry.producedModel ? { producedModel: entry.producedModel } : {}),
      };
      return <AgentChip chip={nextChip} />;
    }
  }
  const toolText = hooks?.formatResult?.(entry.text, meta.input) ?? entry.text;
  const workflowPayload = workflowStatusPayload({
    name: meta.name,
    callId: meta.callId,
    isError: entry.isError ?? false,
  });
  const metaPayload =
    meta.phase === "complete" && entry.resultMeta ? payloadFromMeta(entry.resultMeta) : null;
  const payload = resolveToolPayload(meta, entry, toolText, metaPayload, workflowPayload);
  const elapsedMs =
    isRunning && entry.startedAt !== undefined ? Date.now() - entry.startedAt : undefined;
  return (
    <Box marginTop={1}>
      <ToolRender
        name={meta.name}
        args={meta.input}
        status={toolRenderStatus(meta, entry)}
        payload={payload}
        providerShortKey={providerShortKey}
        {...(currentModel !== undefined ? { currentModel } : {})}
        {...(entry.producedModel ? { producedModel: entry.producedModel } : {})}
        {...(meta.name === "Agent" && entry.agentModel
          ? { agentSuffix: displayModelName(entry.agentModel) }
          : {})}
        {...(meta.name === "Read" &&
        entry.resultMeta?.kind === "image" &&
        entry.resultMeta.visionModel
          ? { visionModel: entry.resultMeta.visionModel }
          : {})}
        {...(entry.nested ? { nestedEntries: entry.nested } : {})}
        {...(entry.isBackgrounded ? { isBackgrounded: true } : {})}
        {...(elapsedMs !== undefined ? { elapsedMs } : {})}
        {...(hooks ? { hooks } : {})}
      />
    </Box>
  );
}
