import { MAX_AGENT_SPAWN_DEPTH } from "@/engine/agents/agent-context.ts";
import { listRunning as listRunningBackgroundTasks } from "@/engine/background/tasks/background.ts";
import { listWorkflowTasks } from "@/engine/background/workflows/runtime/store/store.ts";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import { accountFingerprint } from "@/engine/providers/_shared/account-identity.ts";
import * as providers from "@/engine/providers/registry.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import { AUTOCOMPACT_RAPID_REFILL_ERROR_MESSAGE } from "@/engine/session/compact/index.ts";
import type { UsageSnapshot } from "@/engine/session/compact/token-count.ts";
import { releaseForkChain } from "@/engine/session/infra.ts";
import { appendAgentRecordRaw } from "@/engine/session/persist.ts";
import { nowIso } from "@/engine/session/record/index.ts";
import {
  appendTaskReminderMessage,
  buildTaskReminderInjection,
} from "@/engine/session/task-reminder.ts";
import { killShellsForOwner } from "@/engine/tools/builtins/bash.ts";
import type { ToolSchema } from "@/engine/tools/contract.ts";
import { activeDeferredToolNames, declaredSchemasForOverrides } from "@/engine/tools/deferred.ts";
import * as toolRegistry from "@/engine/tools/registry.ts";
import type { ProviderToolDeclaration } from "@/engine/translator/index.ts";
import { getAssembledTurn, sanitizeMessages } from "@/engine/translator/index.ts";
import { streamWithRetry } from "@/engine/transport/_infra/classify/retry.ts";
import { isMcpToolName } from "@/kernel/mcp/index.ts";
import { throwIfAborted } from "@/kernel/std/stream/abort.ts";
import type { ForkEventSink } from "@/kernel/std/types/events.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";
import { lastAssistantRequestId } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { wrapNotificationForModel } from "../../tasks/notification.ts";
import {
  compileOutputSchema,
  STRUCTURED_OUTPUT_FORCING_INSTRUCTION,
  STRUCTURED_OUTPUT_NUDGE_MESSAGE,
  STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from "../structured-output.ts";
import { combineAbortSignals } from "./abort.ts";
import { isForkOverBlockingLimit, maybeCompactFork, maybeMicroCompactFork } from "./compact.ts";
import { composeForkSystem } from "./compose.ts";
import {
  DEGENERATE_TOOL_LOOP_MESSAGE,
  FORK_PROMPT_TOO_LONG_MESSAGE,
  FORK_RAPID_REFILL_TURN_THRESHOLD,
  MAX_DEGENERATE_TOOL_CALLS,
  MAX_FORK_COMPACT_FAILURES,
  MAX_FORK_RAPID_REFILLS,
  MAX_FORK_STALL_RETRIES,
  STRUCTURED_OUTPUT_RETRIES_EXCEEDED,
  WORKFLOW_DEFAULT_STALL_MS,
  WORKFLOW_STALL_ABORT_REASON,
} from "./constants.ts";
import { fireSubagentStartHooks, fireSubagentStopHooks, registerAgentHooks } from "./hooks.ts";
import { buildForkMessages } from "./messages.ts";
import { injectQueuedUserInput } from "./queued-input.ts";
import { withGuaranteedReport } from "./report.ts";
import { isTooShortForReturn } from "./return-quality.ts";
import { withSidechainMetadata } from "./sidechain.ts";
import { agentSpawnDepthFromContext } from "./spawn-depth.ts";
import { consumeForkStream, FORK_MAX_ATTEMPTS } from "./stream-consumer.ts";
import { maxStructuredOutputRetries } from "./structured-retries.ts";
import {
  applyForkToolResultBudget,
  dispatchForkToolCalls,
  type ForkToolDispatchState,
  forkToolDescription,
  isAllowedInForkDeclarations,
} from "./tool-dispatch.ts";
import type { ForkSpec, SidechainRecord, SubagentResult } from "./types.ts";

// A fork must not settle while it still owns running background work: a
// background agent/shell or a launched workflow keyed to this fork id keeps the
// owner alive so its completion routes back here instead of stranding. This is
// the keepalive contract — exported for direct regression coverage.
export function hasRunningOwnedWork(ownerId: string): boolean {
  if (listRunningBackgroundTasks().some((task) => task.ownerId === ownerId)) return true;
  return listWorkflowTasks().some((task) => task.ownerId === ownerId && task.status === "running");
}

function hasPendingOwnedNotification(ownerId: string): boolean {
  return emitQueue
    .peek({ ownerId })
    .some((item) => item.target === "inventory" && item.payload.kind === "task_notification_xml");
}

const NAMED_SUBAGENT_TOOL_ORDER = [
  "Agent",
  "Bash",
  "Edit",
  "Read",
  "Skill",
  "ToolSearch",
  "DeferredToolPlaceholder",
  "Write",
] as const;

const INHERITED_FORK_TOOL_ORDER = [
  "Agent",
  "AskUserQuestion",
  "Bash",
  "Edit",
  "Read",
  "ReportFindings",
  "Skill",
  "ToolSearch",
  "Workflow",
  "DeferredToolPlaceholder",
  "Write",
] as const;

const DEFERRED_TOOL_PLACEHOLDER: ProviderToolDeclaration = {
  name: "DeferredToolPlaceholder",
  description:
    "Reserved placeholder that keeps deferred tool loading active; never call this tool.",
  input_schema: { type: "object", properties: {} },
  defer_loading: true,
};

function toSubagentDeclaration(schema: ToolSchema, ctx: RequestContext): ProviderToolDeclaration {
  return {
    name: schema.name,
    description: forkToolDescription(schema.name, schema.description, {
      providerId: ctx.provider,
      model: ctx.model,
      multiprovider: ctx.multiproviderEnabled === true,
    }),
    input_schema:
      typeof schema.inputSchema.type === "string"
        ? schema.inputSchema
        : { type: "object", properties: {}, ...schema.inputSchema },
  };
}

function isSkillToolName(name: string): boolean {
  return toolRegistry.getNamespace(name)?.startsWith("skill:") ?? false;
}

function atNestedSpawnCeiling(name: string): boolean {
  return (
    (name === "Agent" || name === "Skill") && agentSpawnDepthFromContext() >= MAX_AGENT_SPAWN_DEPTH
  );
}

export function withStructuredOutputDeclaration(
  declarations: ProviderToolDeclaration[],
  outputSchema: Record<string, unknown>,
): ProviderToolDeclaration[] {
  return [
    ...declarations.filter((declaration) => declaration.name !== STRUCTURED_OUTPUT_TOOL_NAME),
    {
      name: STRUCTURED_OUTPUT_TOOL_NAME,
      description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
      input_schema: outputSchema,
    },
  ];
}

export function buildSubagentBaseDeclarations(
  spec: ForkSpec,
  ctx: RequestContext,
): {
  parentTurn: ReturnType<typeof getAssembledTurn>;
  declarations: ProviderToolDeclaration[];
} {
  const provider = providers.get(ctx.provider);
  const parentTurn = spec.inheritParentTurn ? getAssembledTurn(ctx.sessionId) : undefined;
  if (parentTurn) {
    const retainedByName = new Map(
      parentTurn.tools.map((declaration) => [declaration.name, declaration]),
    );
    const declarations = INHERITED_FORK_TOOL_ORDER.flatMap((name) => {
      if (name === "DeferredToolPlaceholder" && provider.id !== "anthropic") return [];
      const declaration = retainedByName.get(name);
      return declaration === undefined || atNestedSpawnCeiling(name) ? [] : [declaration];
    });
    for (const declaration of parentTurn.tools) {
      if (
        (isMcpToolName(declaration.name) || isSkillToolName(declaration.name)) &&
        !declarations.some((existing) => existing.name === declaration.name)
      ) {
        declarations.push(declaration);
      }
    }
    const implemented = new Set(toolRegistry.list().map((handler) => handler.schema.name));
    const activeDeferred = new Set(activeDeferredToolNames());
    for (const schema of declaredSchemasForOverrides(provider.deferredOverrides(), implemented)) {
      if (
        !activeDeferred.has(schema.name) ||
        !isAllowedInForkDeclarations(schema.name, spec.allowSet, spec) ||
        declarations.some((declaration) => declaration.name === schema.name)
      ) {
        continue;
      }
      declarations.push(retainedByName.get(schema.name) ?? toSubagentDeclaration(schema, ctx));
    }
    for (const handler of toolRegistry.list()) {
      const { schema } = handler;
      if (
        !isMcpToolName(schema.name) ||
        !activeDeferred.has(schema.name) ||
        !isAllowedInForkDeclarations(schema.name, spec.allowSet, spec) ||
        declarations.some((declaration) => declaration.name === schema.name)
      ) {
        continue;
      }
      declarations.push(retainedByName.get(schema.name) ?? toSubagentDeclaration(schema, ctx));
    }
    return { parentTurn, declarations };
  }

  const implemented = new Set(toolRegistry.list().map((handler) => handler.schema.name));
  const activeDeferred = new Set(activeDeferredToolNames());
  const schemasByName = new Map(
    declaredSchemasForOverrides(provider.deferredOverrides(), implemented).map((schema) => [
      schema.name,
      schema,
    ]),
  );
  const declarations: ProviderToolDeclaration[] = [];
  for (const name of NAMED_SUBAGENT_TOOL_ORDER) {
    if (name === "DeferredToolPlaceholder") {
      if (provider.id === "anthropic") declarations.push(DEFERRED_TOOL_PLACEHOLDER);
      continue;
    }
    const schema = schemasByName.get(name);
    if (schema === undefined || !isAllowedInForkDeclarations(name, spec.allowSet, spec)) continue;
    declarations.push({
      name,
      description: forkToolDescription(name, schema.description, {
        providerId: provider.id,
        model: ctx.model,
        multiprovider: ctx.multiproviderEnabled === true,
      }),
      input_schema:
        typeof schema.inputSchema.type === "string"
          ? schema.inputSchema
          : { type: "object", properties: {}, ...schema.inputSchema },
    });
  }

  for (const handler of toolRegistry.list()) {
    const { schema } = handler;
    if (
      !isSkillToolName(schema.name) ||
      !isAllowedInForkDeclarations(schema.name, spec.allowSet, spec) ||
      declarations.some((declaration) => declaration.name === schema.name)
    ) {
      continue;
    }
    declarations.push({
      name: schema.name,
      description: forkToolDescription(schema.name, schema.description, {
        providerId: provider.id,
        model: ctx.model,
        multiprovider: ctx.multiproviderEnabled === true,
      }),
      input_schema:
        typeof schema.inputSchema.type === "string"
          ? schema.inputSchema
          : { type: "object", properties: {}, ...schema.inputSchema },
    });
  }
  for (const schema of declaredSchemasForOverrides(provider.deferredOverrides(), implemented)) {
    if (
      !activeDeferred.has(schema.name) ||
      !isAllowedInForkDeclarations(schema.name, spec.allowSet, spec) ||
      declarations.some((declaration) => declaration.name === schema.name)
    ) {
      continue;
    }
    declarations.push(toSubagentDeclaration(schema, ctx));
  }
  for (const handler of toolRegistry.list()) {
    const { schema } = handler;
    if (
      !isMcpToolName(schema.name) ||
      !activeDeferred.has(schema.name) ||
      !isAllowedInForkDeclarations(schema.name, spec.allowSet, spec) ||
      declarations.some((declaration) => declaration.name === schema.name)
    ) {
      continue;
    }
    declarations.push(toSubagentDeclaration(schema, ctx));
  }
  for (const declaration of spec.extraDeclarations ?? []) {
    if (!declarations.some((existing) => existing.name === declaration.name)) {
      declarations.push(declaration);
    }
  }
  return { parentTurn, declarations };
}

export async function runForkLoopInContext(
  spec: ForkSpec,
  forkId: string,
  ctx: RequestContext,
): Promise<SubagentResult> {
  const { name, body, allowSet, prompt, description, sink } = spec;
  const provider = providers.get(ctx.provider);
  const emit = (event: Parameters<ForkEventSink>[0]): void => sink?.(event);
  const parentRef = spec.parentToolCallId ? { parentToolCallId: spec.parentToolCallId } : {};

  const effortRef = ctx.effort !== null ? { effort: ctx.effort } : {};
  const startEvent: Parameters<ForkEventSink>[0] = description
    ? {
        kind: "fork_start",
        forkId,
        name,
        provider: ctx.provider,
        model: ctx.model,
        ...effortRef,
        description,
        ...parentRef,
      }
    : {
        kind: "fork_start",
        forkId,
        name,
        provider: ctx.provider,
        model: ctx.model,
        ...effortRef,
        ...parentRef,
      };
  emit(startEvent);

  let sidechainWriteTail: Promise<void> = Promise.resolve();
  const appendSidechainRecord = (record: SidechainRecord): void => {
    const nextRecord = withSidechainMetadata(record, spec);
    sidechainWriteTail = sidechainWriteTail
      .then(() =>
        appendAgentRecordRaw(
          { cwd: ctx.originalCwd ?? ctx.cwd, sessionId: ctx.sessionId, agentId: forkId },
          nextRecord,
        ),
      )
      .catch((err) => {
        const error = err instanceof Error ? err.message : String(err);
        const event: Parameters<ForkEventSink>[0] = {
          kind: "sidechain_persist_error",
          agentId: spec.agentId ?? forkId,
          error,
          ...(spec.parentToolCallId ? { parentToolCallId: spec.parentToolCallId } : {}),
        };
        emit(event);
      });
  };
  const finish = async (event: Parameters<ForkEventSink>[0], result: SubagentResult) => {
    emit(event);
    await sidechainWriteTail;
    return result;
  };

  appendSidechainRecord({
    type: "user_message",
    ts: nowIso(),
    content: prompt,
    provider: ctx.provider,
    model: ctx.model,
    ...(spec.promptInlineImages !== undefined && spec.promptInlineImages.length > 0
      ? { inlineImages: spec.promptInlineImages }
      : {}),
  });

  let compiledSchema: ReturnType<typeof compileOutputSchema> | null = null;
  if (!spec.inheritParentTurn && spec.outputSchema !== undefined) {
    const compiled = compileOutputSchema(spec.outputSchema);
    if (compiled.kind === "invalid") {
      return await finish(
        {
          kind: "fork_complete",
          forkId,
          output: `agent({schema}) received an invalid JSON Schema: ${compiled.error}`,
          isError: true,
          ...parentRef,
        },
        {
          output: `agent({schema}) received an invalid JSON Schema: ${compiled.error}`,
          isError: true,
        },
      );
    }
    compiledSchema = compiled;
  }

  const { parentTurn, declarations: baseDeclarations } = buildSubagentBaseDeclarations(spec, ctx);
  const declarations: ProviderToolDeclaration[] =
    compiledSchema !== null && spec.outputSchema !== undefined
      ? withStructuredOutputDeclaration(baseDeclarations, spec.outputSchema)
      : baseDeclarations;

  const fork: Message[] =
    spec.initialMessages ?? buildForkMessages(ctx, name, body, prompt, spec.skillMessages);
  if (!parentTurn && fork[0]?.role !== "system") {
    fork.unshift({
      role: "system",
      content: composeForkSystem({ ctx, name, body, firstPrompt: prompt }),
    });
  }
  if (compiledSchema !== null) {
    fork.push({
      role: "user",
      content: [{ type: "text", text: STRUCTURED_OUTPUT_FORCING_INSTRUCTION }],
    });
  }

  const hookHandlers = registerAgentHooks(forkId, ctx.sessionId, spec.agentHooks, name);
  await fireSubagentStartHooks(forkId, ctx.sessionId, spec.agentId ?? name);

  let lastText = "";
  let compactFailures = 0;
  let lastCompactTurn: number | null = null;
  let lastForkUsage: UsageSnapshot | null = null;
  let rapidRefills = 0;
  let expandReprompts = 0;
  let ownedCompletionGraceUsed = false;
  let lastTurnStopReason = "stop";
  let lastTurnOutputTokens = 0;
  const maxStructuredRetries = maxStructuredOutputRetries();
  let dispatchState: ForkToolDispatchState = {
    degenerateToolCalls: 0,
    lastFailingSignature: null,
    structuredOutputRetries: 0,
    lastStructuredError: null,
    structuredValue: undefined,
    structuredOutputConsumed: false,
  };

  const failStructuredOutputRetries = (): Promise<SubagentResult> => {
    const detail =
      dispatchState.lastStructuredError !== null
        ? ` — last schema error: ${dispatchState.lastStructuredError}`
        : "";
    const output = `Reached maximum StructuredOutput retries (${maxStructuredRetries})${detail}`;
    appendSidechainRecord({
      type: "assistant_message",
      ts: nowIso(),
      content: output,
      provider: ctx.provider,
      model: ctx.model,
    });
    return finish(
      { kind: "fork_complete", forkId, output, isError: true, ...parentRef },
      { output, isError: true, stopReason: STRUCTURED_OUTPUT_RETRIES_EXCEEDED },
    );
  };

  const stallMs =
    spec.stallMs ??
    getProviderConfig(ctx.provider)?.contentIdleTimeoutMs ??
    WORKFLOW_DEFAULT_STALL_MS;
  let stallController = new AbortController();
  let streamSignal = combineAbortSignals(ctx.abortSignal, stallController.signal);
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let lastStallLabel = "fork-start";
  let lastStallArmAt = Date.now();
  let consecutiveStalls = 0;
  const clearStallTimer = (): void => {
    if (stallTimer !== undefined) {
      clearTimeout(stallTimer);
      stallTimer = undefined;
    }
  };
  const armStallTimer = (label: string): void => {
    clearStallTimer();
    lastStallLabel = label;
    lastStallArmAt = Date.now();
    if (stallMs > 0) {
      stallTimer = setTimeout(() => stallController.abort(WORKFLOW_STALL_ABORT_REASON), stallMs);
    }
  };
  const isStalled = (): boolean =>
    stallController.signal.aborted && ctx.abortSignal?.aborted !== true;
  const runStart = Date.now();

  try {
    for (let turn = 0; ; turn++) {
      for (const declaration of buildSubagentBaseDeclarations(spec, ctx).declarations) {
        if (!declarations.some((existing) => existing.name === declaration.name)) {
          const structuredIndex = declarations.findIndex(
            (existing) => existing.name === STRUCTURED_OUTPUT_TOOL_NAME,
          );
          declarations.splice(
            structuredIndex < 0 ? declarations.length : structuredIndex,
            0,
            declaration,
          );
        }
      }
      throwIfAborted(ctx.abortSignal);
      if (spec.maxTurns !== undefined && turn >= spec.maxTurns) {
        // A fork keeps itself alive while it owns running background work so the
        // completion routes back here (the keepalive park below). Hitting
        // maxTurns at that exact boundary must not strand a completion the fork
        // explicitly waited for — otherwise it reroutes to main with no context
        // and the fork's answer omits it. Grant one final turn to drain and
        // answer over the pending completion, then stop. Single-shot so a
        // spawn-wait loop cannot outrun the cap.
        if (ownedCompletionGraceUsed || !hasPendingOwnedNotification(forkId)) break;
        ownedCompletionGraceUsed = true;
      }

      const ownedNotifications = emitQueue
        .takeForOwner(forkId)
        .map((item) => (item.payload.kind === "task_notification_xml" ? item.payload.text : null))
        .filter((text): text is string => text !== null);
      if (ownedNotifications.length > 0) {
        fork.push({
          role: "user",
          content: ownedNotifications.map((text) => ({
            type: "text",
            text: wrapNotificationForModel(text),
          })),
        });
        for (const text of ownedNotifications) {
          appendSidechainRecord({
            type: "user_message",
            ts: nowIso(),
            content: wrapNotificationForModel(text),
            provider: ctx.provider,
            model: ctx.model,
          });
        }
      }

      injectQueuedUserInput({ spec, fork, ctx, appendSidechainRecord });

      if (turn > 0) {
        maybeMicroCompactFork(fork, ctx, lastForkUsage, appendSidechainRecord);
      }
      if (turn > 0 && rapidRefills >= MAX_FORK_RAPID_REFILLS) {
        appendSidechainRecord({
          type: "assistant_message",
          ts: nowIso(),
          content: AUTOCOMPACT_RAPID_REFILL_ERROR_MESSAGE,
          provider: ctx.provider,
          model: ctx.model,
        });
        return await finish(
          {
            kind: "fork_complete",
            forkId,
            output: AUTOCOMPACT_RAPID_REFILL_ERROR_MESSAGE,
            isError: true,
            ...parentRef,
          },
          { output: AUTOCOMPACT_RAPID_REFILL_ERROR_MESSAGE, isError: true },
        );
      }
      if (compactFailures >= MAX_FORK_COMPACT_FAILURES) {
        // Re-arm once enough turns have passed since the last compact attempt
        // without a rapid refill — mirrors the main session breaker
        // (queue/runtime/compact/auto.ts): left permanently open, 3 transient
        // failures (e.g. a network blip) would disable compaction for the
        // rest of the fork run, so the transcript grows unbounded until it
        // 400s. A genuine repeat failure just re-trips it.
        const turnsSinceLastCompact = lastCompactTurn === null ? turn : turn - lastCompactTurn;
        if (turnsSinceLastCompact >= FORK_RAPID_REFILL_TURN_THRESHOLD) {
          compactFailures = 0;
        }
      }

      // The blocking-limit guard runs on every turn, including turn 0: a fork
      // that inherits a near-full parent transcript (dispatchFork) can be over
      // the ceiling before it ever sends a request, so the regular turn > 0
      // gate below must not be the only path into a compaction attempt.
      const overBlockingLimitBeforeCompact = isForkOverBlockingLimit(fork, ctx, lastForkUsage);
      if (
        (turn > 0 || overBlockingLimitBeforeCompact) &&
        compactFailures < MAX_FORK_COMPACT_FAILURES
      ) {
        const outcome = await maybeCompactFork(fork, ctx, lastForkUsage, declarations);
        if (outcome === "compacted") {
          if (
            lastCompactTurn !== null &&
            turn - lastCompactTurn < FORK_RAPID_REFILL_TURN_THRESHOLD
          ) {
            rapidRefills += 1;
          } else {
            rapidRefills = 0;
          }
          lastCompactTurn = turn;
          // The stale usage snapshot no longer describes the (now much
          // smaller) fork transcript, and no message carries its own `usage`
          // field, so leaving it set would make the very next token estimate
          // report the pre-compaction size. Clearing it forces a fresh
          // rough estimate from the compacted messages themselves.
          lastForkUsage = null;
        } else if (outcome === "failed") {
          compactFailures += 1;
        }
      }
      if (
        overBlockingLimitBeforeCompact &&
        (compactFailures >= MAX_FORK_COMPACT_FAILURES ||
          isForkOverBlockingLimit(fork, ctx, lastForkUsage))
      ) {
        appendSidechainRecord({
          type: "assistant_message",
          ts: nowIso(),
          content: FORK_PROMPT_TOO_LONG_MESSAGE,
          provider: ctx.provider,
          model: ctx.model,
        });
        return await finish(
          {
            kind: "fork_complete",
            forkId,
            output: FORK_PROMPT_TOO_LONG_MESSAGE,
            isError: true,
            ...parentRef,
          },
          { output: FORK_PROMPT_TOO_LONG_MESSAGE, isError: true },
        );
      }
      throwIfAborted(ctx.abortSignal);
      const budgetFork = await applyForkToolResultBudget(fork, ctx, appendSidechainRecord);
      fork.splice(0, fork.length, ...budgetFork);
      const taskReminder = buildTaskReminderInjection({
        messages: fork,
        scope: ctx.agentOwnerId,
        effectiveTools: declarations,
      });
      if (taskReminder !== null) appendTaskReminderMessage(fork, taskReminder);
      if (!parentTurn && fork[0]?.role === "system") {
        const prevRequestId = lastAssistantRequestId(fork);
        fork[0] = {
          role: "system",
          content: composeForkSystem({
            ctx,
            name,
            body,
            firstPrompt: prompt,
            ...(prevRequestId ? { previousRequestId: prevRequestId } : {}),
          }),
        };
      }
      const requestMessages = parentTurn
        ? provider.composeMessages(parentTurn.harness, sanitizeMessages(fork))
        : provider.applyTrailingCacheControl
          ? provider.applyTrailingCacheControl(fork)
          : fork;
      const streamCtx: RequestContext = { ...ctx, abortSignal: streamSignal };
      const reqBody = provider.translateRequest(streamCtx, requestMessages, declarations);
      armStallTimer("stream-start");
      const stream = streamWithRetry(streamCtx, provider, reqBody, {
        maxAttempts: FORK_MAX_ATTEMPTS,
      });

      const streamOutcome = await consumeForkStream({
        stream,
        streamSignal,
        ctx,
        forkId,
        parentRef,
        emit,
        streamToolInputFor: spec.streamToolInputFor,
        finish,
        armStallTimer,
        isStalled,
        stallMs,
        getLastStallLabel: () => lastStallLabel,
        getLastStallArmAt: () => lastStallArmAt,
        consecutiveStalls,
        maxStallRetries: MAX_FORK_STALL_RETRIES,
        turn,
        appendSidechainRecord,
        runStart,
        resetStall: () => {
          stallController = new AbortController();
          streamSignal = combineAbortSignals(ctx.abortSignal, stallController.signal);
        },
      });
      clearStallTimer();
      consecutiveStalls = streamOutcome.consecutiveStalls;
      if (streamOutcome.kind === "retry") {
        turn -= 1;
        continue;
      }
      if (streamOutcome.kind === "finished") return streamOutcome.result;

      const {
        text,
        thinking,
        thinkingSignature,
        toolCalls,
        stopReason,
        refusalExplanation,
        usage,
      } = streamOutcome;
      lastTurnStopReason = stopReason;
      lastTurnOutputTokens = usage.outputTokens;

      if (usage.inputTokens || usage.outputTokens) {
        emit({
          kind: "fork_usage",
          forkId,
          provider: ctx.provider,
          model: ctx.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          thoughtTokens: usage.thoughtTokens ?? 0,
          cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
          cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
          ...parentRef,
        });
        appendSidechainRecord({
          type: "usage",
          ts: nowIso(),
          provider: ctx.provider,
          model: ctx.model,
          session_id: ctx.sessionId,
          request_count: 1,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          thought_tokens: usage.thoughtTokens ?? 0,
          cache_creation_input_tokens: usage.cacheCreationInputTokens ?? 0,
          cache_read_input_tokens: usage.cacheReadInputTokens ?? 0,
        });
        lastForkUsage = usage;
      }

      if (text.length > 0) lastText = text;

      const blocks: ContentBlock[] = [];
      if (thinking.length > 0 || thinkingSignature.length > 0) {
        const block: { type: "thinking"; text: string; signature?: string } = {
          type: "thinking",
          text: thinking,
        };
        if (thinkingSignature) block.signature = thinkingSignature;
        blocks.push(block);
      }
      if (text.length > 0) blocks.push({ type: "text", text });
      if (text.length > 0 || thinking.length > 0) {
        appendSidechainRecord({
          type: "assistant_message",
          ts: nowIso(),
          content: text,
          provider: ctx.provider,
          model: ctx.model,
          ...(thinking.length > 0 ? { thinking } : {}),
        });
      }
      for (const c of toolCalls) {
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
        appendSidechainRecord({
          type: "tool_call",
          ts: nowIso(),
          tool_name: c.name,
          args: c.input,
          call_id: c.id,
          provider: ctx.provider,
          model: ctx.model,
        });
      }
      if (blocks.length > 0) {
        const account = accountFingerprint(ctx.provider);
        fork.push({
          role: "assistant",
          content: blocks,
          producedBy: ctx.provider,
          producedModel: ctx.model,
          ...(account ? { producedAccount: account } : {}),
          ...(streamCtx.responseRequestId ? { requestId: streamCtx.responseRequestId } : {}),
        });
      }

      if (stopReason === "refusal") {
        const refusalOut =
          refusalExplanation && refusalExplanation.trim().length > 0
            ? refusalExplanation
            : "The model declined to respond to this request.";
        appendSidechainRecord({
          type: "assistant_message",
          ts: nowIso(),
          content: refusalOut,
          provider: ctx.provider,
          model: ctx.model,
        });
        return await finish(
          { kind: "fork_complete", forkId, output: refusalOut, isError: true, ...parentRef },
          { output: refusalOut, isError: true },
        );
      }

      if (stopReason !== "tool_calls" || toolCalls.length === 0) {
        if (compiledSchema !== null && !dispatchState.structuredOutputConsumed) {
          if (dispatchState.structuredOutputRetries >= maxStructuredRetries) {
            return await failStructuredOutputRetries();
          }
          dispatchState.structuredOutputRetries += 1;
          fork.push({
            role: "user",
            content: [{ type: "text", text: STRUCTURED_OUTPUT_NUDGE_MESSAGE }],
          });
          appendSidechainRecord({
            type: "user_message",
            ts: nowIso(),
            content: STRUCTURED_OUTPUT_NUDGE_MESSAGE,
            provider: ctx.provider,
            model: ctx.model,
          });
          continue;
        }
        if (expandReprompts < 1 && isTooShortForReturn(text)) {
          expandReprompts += 1;
          const reprompt =
            'Your previous message was too short to be useful to the calling agent. The caller ONLY sees your final assistant message — not your tool calls, intermediate reads, or working notes. Expand your response now into a complete, self-contained summary covering everything the caller asked for: findings, results, paths to any files you wrote, severity tallies if applicable. Do not respond with single words like "done". Write the full deliverable.';
          fork.push({ role: "user", content: [{ type: "text", text: reprompt }] });
          appendSidechainRecord({
            type: "user_message",
            ts: nowIso(),
            content: reprompt,
            provider: ctx.provider,
            model: ctx.model,
          });
          continue;
        }
        if (injectQueuedUserInput({ spec, fork, ctx, appendSidechainRecord })) continue;
        if (hasPendingOwnedNotification(forkId)) continue;
        if (hasRunningOwnedWork(forkId)) {
          await emitQueue.waitForOwner(forkId, ctx.abortSignal);
          continue;
        }
        break;
      }

      const dispatchOutcome = await dispatchForkToolCalls({
        toolCalls,
        ctx,
        spec,
        forkId,
        name,
        allowSet,
        parentRef,
        compiledSchema,
        hookHandlers,
        state: dispatchState,
        emit,
        finish,
        appendSidechainRecord,
      });
      if (dispatchOutcome.kind === "finished") return dispatchOutcome.result;
      dispatchState = dispatchOutcome.state;
      fork.push({ role: "user", content: dispatchOutcome.results });
      // Foreground nested-task terminal publication is deliberately after the
      // Agent tool_result enters the parent sidechain. Detached completions do
      // not wait here; they route through the owner's FIFO inventory instead.
      dispatchOutcome.commitTaskCompletions();

      if (dispatchState.structuredOutputConsumed) break;
      if (
        compiledSchema !== null &&
        !dispatchState.structuredOutputConsumed &&
        dispatchState.structuredOutputRetries >= maxStructuredRetries
      ) {
        return await failStructuredOutputRetries();
      }
      if (dispatchState.degenerateToolCalls >= MAX_DEGENERATE_TOOL_CALLS) {
        appendSidechainRecord({
          type: "assistant_message",
          ts: nowIso(),
          content: DEGENERATE_TOOL_LOOP_MESSAGE,
          provider: ctx.provider,
          model: ctx.model,
        });
        return await finish(
          {
            kind: "fork_complete",
            forkId,
            output: DEGENERATE_TOOL_LOOP_MESSAGE,
            isError: true,
            ...parentRef,
          },
          { output: DEGENERATE_TOOL_LOOP_MESSAGE, isError: true },
        );
      }
    }

    const output = lastText.length > 0 ? lastText : "(Subagent completed but returned no output.)";
    const finalOutput = withGuaranteedReport(body, output);
    const baseResult: SubagentResult = {
      output: finalOutput,
      isError: false,
      stopReason: lastTurnStopReason,
      outputTokens: lastTurnOutputTokens,
      durationMs: Date.now() - runStart,
    };
    const finalResult: SubagentResult =
      dispatchState.structuredValue !== undefined
        ? { ...baseResult, structured: dispatchState.structuredValue }
        : baseResult;
    return await finish(
      { kind: "fork_complete", forkId, output: finalOutput, isError: false, ...parentRef },
      finalResult,
    );
  } finally {
    clearStallTimer();
    stallController.abort();
    killShellsForOwner(forkId);
    await fireSubagentStopHooks(forkId, ctx.sessionId);
    releaseForkChain(ctx.sessionId, forkId, ctx.originalCwd ?? ctx.cwd);
  }
}
