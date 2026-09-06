import {
  type BackgroundTask,
  list as listBackgroundTasks,
} from "@/engine/background/tasks/background.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import { isProviderId, type ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";
import type { AgentChipDescriptor } from "@/ui/transcript/agent-chip-data.ts";
import type { SettledEntry } from "@/ui/transcript/settled-entry.ts";
import type { ToolEntryData, ToolNestedEntry } from "@/ui/transcript/string-view-tool.ts";
import { buildToolEntryData } from "@/ui/transcript/tool-entry-data.ts";
import { payloadFromMeta } from "@/ui/transcript/tool-render/payload.ts";

/**
 * Copies a finished task's final data onto its transcript entry, once. A settled
 * row must render from the entry alone: the task record ages out of the store,
 * and a settled line whose projection still reads it would change on eviction —
 * reflowing the whole document, which past the viewport strands ghost copies.
 * Idempotent: entries already carrying the data come back by reference.
 */
export function freezeAgentTaskProjection(
  entries: readonly TranscriptEntry[],
): readonly TranscriptEntry[] {
  const finished = new Map(
    listBackgroundTasks()
      .filter((task) => task.kind === "agent" && task.status !== "running")
      .map((task) => [task.parentToolCallId, task]),
  );
  if (finished.size === 0) return entries;
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.kind !== "tool") return entry;
    const task = finished.get(toolCallId(entry.id));
    if (task === undefined) return entry;
    let frozen = entry;
    if ((frozen.nested?.length ?? 0) < task.actions.length) {
      frozen = { ...frozen, nested: nestedEntriesFromTask(task) };
    }
    if (frozen.inputTokens === undefined && task.inputTokens > 0) {
      frozen = { ...frozen, inputTokens: task.inputTokens };
    }
    if (frozen.outputTokens === undefined && task.outputTokens > 0) {
      frozen = { ...frozen, outputTokens: task.outputTokens };
    }
    if (frozen.completedAt === undefined && task.endedAt !== undefined) {
      frozen = { ...frozen, completedAt: task.endedAt };
    }
    // startedAt doubles as the running-elapsed anchor, so only a resolved row
    // (r_) may carry it; a backgrounded row would start ticking as running.
    if (frozen.startedAt === undefined && entry.id.startsWith("r_")) {
      frozen = { ...frozen, startedAt: task.startedAt };
    }
    if (frozen !== entry) changed = true;
    return frozen;
  });
  return changed ? next : entries;
}

export function mapTranscriptEntries(entries: readonly TranscriptEntry[]): SettledEntry[] {
  // Only a running task feeds its row: the row is live then, so instability is
  // free. A finished task's data reaches the row through the freeze above —
  // never through this lookup, which eviction would silently empty.
  const agentTasks = new Map(
    listBackgroundTasks()
      .filter((task) => task.kind === "agent" && task.status === "running")
      .map((task) => [task.parentToolCallId, task]),
  );
  const mapped: SettledEntry[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case "user":
        mapped.push({
          kind: "user",
          text: entry.text,
          ...(entry.anchor !== undefined ? { anchor: entry.anchor } : {}),
          images: entry.images ?? [],
        });
        break;
      case "assistant":
        mapped.push({
          kind: "assistant",
          text: entry.text,
          ...(entry.continuation === true ? { continuation: true } : {}),
        });
        break;
      case "thinking":
        mapped.push({
          kind: "thinking",
          text: entry.text,
          ...(entry.detailOnly === true ? { detailOnly: true } : {}),
        });
        break;
      case "slash_error":
      case "command_output":
      case "quota_gutter":
      case "compact_done":
        mapped.push({ kind: entry.kind, text: entry.text });
        break;
      case "retry":
        mapped.push({
          kind: "retry",
          text: entry.text,
          ...(entry.input !== undefined ? { input: entry.input } : {}),
        });
        break;
      case "ask_answer":
        mapped.push({
          kind: "ask_answer",
          text: entry.text,
          ...(entry.askPayload !== undefined ? { payload: entry.askPayload } : {}),
        });
        break;
      case "system":
        mapped.push({ kind: "system", text: entry.text, isError: entry.isError === true });
        break;
      case "task_notice":
        mapped.push({ kind: "task_notice", text: entry.text, isError: entry.isError === true });
        break;
      case "api_error":
        mapped.push({ kind: "api_error", text: entry.text });
        break;
      case "bash_input": {
        const payload = entry.resultMeta ? payloadFromMeta(entry.resultMeta) : null;
        const status =
          entry.resultMeta?.kind === "bash" && (entry.resultMeta.exit_code ?? 0) !== 0
            ? "error"
            : "ok";
        mapped.push({ kind: "bash_input", text: entry.text, payload, status });
        break;
      }
      case "skill":
        mapped.push({
          kind: "skill",
          text: entry.text,
          isError: entry.isError === true,
          progress: entry.progress ?? [],
          isActive: entry.isActive === true,
        });
        break;
      case "compaction":
        mapped.push({
          kind: "compaction",
          text: entry.text,
          isError: entry.isError === true,
          filesRead: entry.filesRead ?? [],
        });
        break;
      case "tool": {
        const built: ToolEntryData | null = buildToolEntryData(entry);
        if (built === null) break;
        const data =
          built.name === "Agent"
            ? projectAgentTool(entry, built, agentTasks.get(toolCallId(entry.id)))
            : built;
        mapped.push({ kind: "tool", data });
        break;
      }
    }
  }
  return mapped;
}

function projectAgentTool(
  entry: TranscriptEntry,
  data: ToolEntryData,
  task: BackgroundTask | undefined,
): ToolEntryData {
  const args = agentArgs(data.args, task);
  const agentRoute = agentRouteFor(entry, args, task);
  const producerRoute = producerRouteFor(entry);
  const backgrounded = data.isBackgrounded === true || task?.isBackgrounded === true;
  // A backgrounded row settles at launch with a frozen projection: it never
  // reads the live task's mutating fields (nested actions), so the settled
  // document stays stable while the task runs — its ticking lives in the
  // footer bullets, and the final state restamps the entry on completion,
  // reflowing the archive once through the non-destructive reflow path.
  const liveFeed = task?.status === "running" && !backgrounded;
  const nested =
    data.nested && data.nested.length > 0
      ? data.nested
      : liveFeed
        ? nestedEntriesFromTask(task)
        : [];
  const completionChip = completionChipFor({
    entry,
    data,
    args,
    task,
    agentRoute,
    producerRoute,
  });
  return {
    ...data,
    args,
    completionChip,
    nested,
    isBackgrounded: backgrounded,
    // Only a sync (non-backgrounded) task keeps rewriting this row, so only
    // that row must ride the live frame instead of settling into the document.
    ...(liveFeed ? { taskRunning: true } : {}),
    ...(agentRoute ? { agentRoute } : {}),
    ...(producerRoute ? { producerRoute } : {}),
  };
}

function agentArgs(args: unknown, task: BackgroundTask | undefined): unknown {
  if (!task) return args;
  const values = isRecord(args) ? { ...args } : {};
  const currentType = readString(values, "subagent_type");
  if (!currentType || currentType === "general-purpose") values.subagent_type = task.agentName;
  if (!readString(values, "description") && task.description) {
    values.description = task.description;
  }
  const route = task.route;
  if (!readString(values, "provider") && (route?.provider ?? task.provider)) {
    values.provider = route?.provider ?? task.provider;
  }
  if (!readString(values, "model") && (route?.model ?? task.model)) {
    values.model = route?.model ?? task.model;
  }
  return values;
}

function agentRouteFor(
  entry: TranscriptEntry,
  args: unknown,
  task: BackgroundTask | undefined,
): ProviderModelRoute | undefined {
  if (task?.route) return task.route;
  if (task?.provider && task.model) return { provider: task.provider, model: task.model };
  if (entry.agentRoute) return entry.agentRoute;
  if (entry.agentProvider && entry.agentModel) {
    return { provider: entry.agentProvider, model: entry.agentModel };
  }
  const provider = readString(args, "provider");
  const model = readString(args, "model");
  return provider && model && isProviderId(provider) ? { provider, model } : undefined;
}

function producerRouteFor(entry: TranscriptEntry): ProviderModelRoute | undefined {
  if (entry.producedRoute) return entry.producedRoute;
  return entry.producedModel && entry.producedBy && isProviderId(entry.producedBy)
    ? { provider: entry.producedBy, model: entry.producedModel }
    : undefined;
}

function nestedEntriesFromTask(task: BackgroundTask | undefined): ToolNestedEntry[] {
  if (!task) return [];
  return task.actions.map((action) => ({
    toolName: action.toolName,
    args: null,
    running: action.running,
    ...(action.argsLabel.length > 0 ? { argumentLabel: action.argsLabel } : {}),
  }));
}

function completionChipFor(input: {
  entry: TranscriptEntry;
  data: ToolEntryData;
  args: unknown;
  task: BackgroundTask | undefined;
  agentRoute: ProviderModelRoute | undefined;
  producerRoute: ProviderModelRoute | undefined;
}): AgentChipDescriptor | null {
  const { entry, data, args, task, agentRoute, producerRoute } = input;
  const chip = data.completionChip ?? null;
  if (!chip) return null;

  // The extras come from the frozen entry, never the task record: the chip
  // belongs to a finished row, and the task it describes ages out of the store.
  const description =
    chip.description || readString(args, "description") || task?.description || "";
  const subagentType = chip.subagentType ?? readString(args, "subagent_type");
  const model = chip.model ?? agentRoute?.model;
  const modelRoute = chip.modelRoute ?? matchingRoute(model, agentRoute, producerRoute);
  const producedRoute =
    chip.producedRoute ?? matchingRoute(chip.producedModel, producerRoute, agentRoute);
  const frozenTokens =
    entry.inputTokens !== undefined || entry.outputTokens !== undefined
      ? (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0)
      : undefined;
  const frozenDuration =
    entry.completedAt !== undefined && entry.startedAt !== undefined
      ? Math.max(0, entry.completedAt - entry.startedAt)
      : undefined;
  const frozenToolUses = entry.nested?.length;
  return {
    ...chip,
    description,
    ...(subagentType ? { subagentType } : {}),
    ...(model ? { model } : {}),
    ...(modelRoute ? { modelRoute } : {}),
    ...(producedRoute ? { producedRoute } : {}),
    ...(chip.toolUses === undefined && frozenToolUses !== undefined && frozenToolUses > 0
      ? { toolUses: frozenToolUses }
      : {}),
    ...(chip.tokens === undefined && frozenTokens !== undefined ? { tokens: frozenTokens } : {}),
    ...(chip.durationMs === undefined && frozenDuration !== undefined
      ? { durationMs: frozenDuration }
      : {}),
  };
}

function matchingRoute(
  model: string | undefined,
  ...routes: readonly (ProviderModelRoute | undefined)[]
): ProviderModelRoute | undefined {
  if (!model) return undefined;
  return routes.find((route) => route?.model === model);
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolCallId(entryId: string): string {
  return entryId.replace(/^[a-z]+_/, "");
}
