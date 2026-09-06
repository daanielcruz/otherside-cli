import {
  resolveWorkflowAgentProfile,
  runForkLoopExternal,
  type SubagentResult,
} from "@/engine/background/subagents/dispatcher.ts";
import { resolveToolModelOverride } from "@/engine/background/subagents/fork/routing.ts";
import {
  acquireWorktreeLease,
  createWorktree,
  type Worktree,
  type WorktreeLease,
} from "@/engine/background/subagents/worktree.ts";
import { enforceWorkflowBudget } from "@/engine/background/workflows/runtime/budget/errors.ts";
import type { WorkflowOutputRecord } from "@/engine/background/workflows/runtime/history/run-ledger.ts";
import { cloneWorkflowBoundaryValue } from "@/engine/background/workflows/runtime/sandbox/clone.ts";
import { toSandboxError } from "@/engine/background/workflows/runtime/sandbox/errors.ts";
import {
  getRunningWorkflowByRunId,
  updateWorkflowTask,
} from "@/engine/background/workflows/runtime/store/store.ts";
import {
  WORKFLOW_AGENT_RETRY_REASON,
  WORKFLOW_AGENT_SKIP_REASON,
  type WorkflowAgentAttemptReason,
} from "@/engine/background/workflows/runtime/store/types.ts";
import { createAgentTranscriptStore } from "@/engine/background/workflows/runtime/transcript/store.ts";
import { findModel } from "@/engine/model/catalog.ts";
import { resolveWithModelFallbackDecision } from "@/engine/model/facts/model-fallback-decision.ts";
import { resolveModelPin } from "@/engine/model/facts/model-pin.ts";
import type { TierResolution } from "@/engine/model/tier/resolver.ts";
import { currentProviderPlan } from "@/engine/providers/_shared/plan.ts";
import { errorMessage } from "@/kernel/std/errno.ts";
import type { ForkEventSink } from "@/kernel/std/types/events.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { deriveAgentCacheKey } from "./agent-cache-key.ts";
import { deriveAgentLabel, trimWorkflowPreview } from "./agent-display.ts";
import { isPlainObject, readAgentOptions } from "./agent-options.ts";
import {
  orchestrationModeOf,
  resolveEffectiveTier,
  resolveWorkflowAgentModelContextDetailed,
  workflowOrchestrationOptionError,
} from "./agent-routing.ts";
import {
  WORKFLOW_MAX_AGENTS,
  type WorkflowAgentEvent,
  type WorkflowAgentModelContextDetail,
  type WorkflowSubagentBridgeOptions,
} from "./bridge-contract.ts";
import type { WorkflowCacheReplay } from "./cache-replay.ts";
import {
  computeWorkflowCpuCount,
  createConcurrencyGate,
  workflowConcurrencyLimit,
} from "./concurrency.ts";
import {
  runForkWithRetries,
  type WorkflowForkRequest,
  type WorkflowForkRunner,
} from "./fork-retries.ts";

const WORKFLOW_PARENT_ABORT_REASON = "workflow-abort";
const WORKFLOW_MAX_USER_RETRIES = 100;

const defaultForkRunner: WorkflowForkRunner = (request) =>
  runForkLoopExternal({
    ctx: request.ctx,
    name: request.name,
    body: request.body,
    allowSet: request.allowSet,
    prompt: request.prompt,
    parentToolCallId: request.parentToolCallId,
    agentId: request.agentId,
    extraDeclarations: request.extraDeclarations,
    ...(request.outputSchema !== undefined ? { outputSchema: request.outputSchema } : {}),
    ...(request.sink !== undefined ? { sink: request.sink } : {}),
    ...(request.isolation !== undefined ? { isolation: request.isolation } : {}),
    ...(request.worktreeKey !== undefined ? { worktreeKey: request.worktreeKey } : {}),
    ...(request.worktree !== undefined ? { worktree: request.worktree } : {}),
  });

let forkRunnerOverride: WorkflowForkRunner | null = null;

export function setWorkflowForkRunnerForTests(runner: WorkflowForkRunner | null): void {
  forkRunnerOverride = runner;
}

function sleepUntilWorkflowFallback(untilEpochMs: number, signal: AbortSignal): Promise<void> {
  const delayMs = Math.max(0, untilEpochMs - Date.now());
  if (delayMs === 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(toSandboxError("Workflow was aborted."));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(toSandboxError("Workflow was aborted."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface WorkflowAgentExecution {
  runAgent: (prompt: unknown, rawOptions?: unknown) => Promise<unknown>;
  agentCount: () => number;
}

export function createWorkflowAgentExecution(
  options: WorkflowSubagentBridgeOptions,
  cacheReplay: WorkflowCacheReplay,
): WorkflowAgentExecution {
  let agentSeq = 0;
  const transcripts = createAgentTranscriptStore();
  const tierAllocationCounts: Record<string, number> = {};
  const tierPinnedPools: Record<string, TierResolution[]> = {};
  const cpuCount = computeWorkflowCpuCount();
  const gate = createConcurrencyGate({
    limitFor: async (provider) =>
      workflowConcurrencyLimit(provider, await currentProviderPlan(provider), cpuCount),
  });
  const activeCacheScope = cacheReplay.activeScope;

  const runAgent = async (prompt: unknown, rawOptions?: unknown): Promise<unknown> => {
    if (options.signal.aborted) throw toSandboxError("Workflow was aborted.");
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw toSandboxError("agent() requires a non-empty prompt string.");
    }
    if (options.budget) enforceWorkflowBudget(options.budget);
    agentSeq += 1;
    if (agentSeq > WORKFLOW_MAX_AGENTS) {
      throw toSandboxError(`Workflow exceeded the ${WORKFLOW_MAX_AGENTS}-agent cap.`);
    }
    const index = agentSeq;
    const opts = readAgentOptions(rawOptions);
    const phaseTitle = opts.phase ?? options.getCurrentPhase?.();
    const label = opts.label ?? deriveAgentLabel(prompt, phaseTitle, index);
    const agentId = `workflow-${options.runId}-${index}`;
    // Reserve identity synchronously, before provider resolution can yield. This
    // keeps even concurrently-created calls deterministic; combinators add their
    // branch/item/stage path through AsyncLocalStorage.
    const cacheScope = activeCacheScope();
    const structuralPath = `${cacheScope.path}/agent:${cacheScope.chain.callIndex}`;
    cacheScope.chain.callIndex += 1;
    const baseCtx: RequestContext = {
      ...options.ctx,
      abortSignal: options.signal,
    };
    const optionError = workflowOrchestrationOptionError(baseCtx, opts);
    // An explicit (provider, model) pin is literal in Default mode. Experimental
    // mode has no concrete pin path; tier routing owns the selection there.
    const explicitPin =
      opts.provider === undefined
        ? null
        : opts.model === undefined
          ? ({
              ok: false,
              error: "InputValidationError: `provider` requires `model` to name the pinned model.",
            } as const)
          : resolveModelPin(
              opts.provider,
              opts.model,
              baseCtx.provider,
              orchestrationModeOf(baseCtx),
            );
    const explicitModel =
      opts.provider === undefined && opts.model !== undefined
        ? resolveToolModelOverride(baseCtx, opts.model)
        : null;
    const effectiveTier =
      optionError === undefined && explicitPin === null && explicitModel === null
        ? resolveEffectiveTier(baseCtx, opts)
        : undefined;
    const effectiveDiversify = optionError === undefined ? opts.diversify : undefined;
    const cacheKey = options.runLog
      ? deriveAgentCacheKey(
          prompt,
          rawOptions,
          structuralPath,
          cacheScope.chain.prevKey,
          orchestrationModeOf(baseCtx),
        )
      : undefined;
    if (cacheKey !== undefined) cacheScope.chain.prevKey = cacheKey;
    const poolKey =
      effectiveTier !== undefined ? `${effectiveTier}:${effectiveDiversify ? "d" : "1"}` : "";
    let allocationCount = 0;
    if (poolKey) {
      allocationCount = tierAllocationCounts[poolKey] ?? 0;
      tierAllocationCounts[poolKey] = allocationCount + 1;
    }
    const resolveContext = (): WorkflowAgentModelContextDetail => {
      if (optionError !== undefined) return { ok: false, ctx: baseCtx, error: optionError };
      if (explicitPin !== null) {
        return explicitPin.ok
          ? {
              ok: true,
              ctx: {
                ...baseCtx,
                provider: explicitPin.resolution.provider,
                model: explicitPin.resolution.model,
              },
            }
          : { ok: false, ctx: baseCtx, error: explicitPin.error };
      }
      if (explicitModel !== null) {
        return explicitModel.ok
          ? { ok: true, ctx: explicitModel.ctx }
          : { ok: false, ctx: baseCtx, error: explicitModel.error };
      }
      return resolveWorkflowAgentModelContextDetailed(
        baseCtx,
        {
          ...(effectiveTier !== undefined ? { tier: effectiveTier } : {}),
          ...(effectiveDiversify !== undefined ? { diversify: effectiveDiversify } : {}),
        },
        { allocationCount },
        poolKey ? tierPinnedPools[poolKey] : undefined,
      );
    };
    const resolved = (
      await resolveWithModelFallbackDecision({
        resolve: resolveContext,
        inspect: (value) => (value.ok ? (value.fallbackDeviation ?? null) : null),
        // Workflow agents are autonomous: never raise the interactive ask and
        // never sleep out a cooldown (a quota window can be hours — the next
        // phase would silently stall). Take the substitute; degraded routing
        // is already surfaced via degradedReasons below.
        decisionHook: async () => ({
          decision: "use_fallback",
          timedOut: false,
        }),
        sleepUntil: (untilEpochMs) => sleepUntilWorkflowFallback(untilEpochMs, options.signal),
      })
    ).value;
    if (poolKey && resolved.ok && resolved.selectedPool && resolved.selectedPool.length > 0) {
      tierPinnedPools[poolKey] = resolved.selectedPool;
    }
    if (resolved.ok && resolved.degradedReasons) {
      const task = getRunningWorkflowByRunId(options.runId);
      if (task) {
        const current = task.degradedRouting || [];
        updateWorkflowTask(task.id, {
          degradedRouting: [...current, ...resolved.degradedReasons],
          logs: [...task.logs, ...resolved.degradedReasons.map((r) => `degraded routing: ${r}`)],
        });
      }
    }
    const selectedCtx = resolved.ok ? resolved.ctx : baseCtx;
    const agentCtx: RequestContext = {
      ...selectedCtx,
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    };
    const modelDisplay =
      findModel({ provider: agentCtx.provider, model: agentCtx.model })?.displayName ??
      agentCtx.model;
    let agentOutputTokens = 0;

    const emit = (
      state: WorkflowAgentEvent["state"],
      extra?: Partial<WorkflowAgentEvent>,
    ): void => {
      const transcript = transcripts.get(agentId);
      const lastCall = transcript?.toolCalls.at(-1);
      const meterTotal = options.meter?.spent();
      options.onAgentEvent?.({
        index,
        label,
        agentId,
        prompt,
        ...(phaseTitle !== undefined ? { phaseTitle } : {}),
        route: { provider: agentCtx.provider, model: agentCtx.model },
        provider: agentCtx.provider,
        model: modelDisplay,
        state,
        ...(transcript !== undefined ? { transcript } : {}),
        ...(lastCall !== undefined
          ? { lastToolName: lastCall.name, lastToolSummary: lastCall.summary }
          : {}),
        ...(agentOutputTokens > 0 ? { tokens: agentOutputTokens } : {}),
        ...(meterTotal !== undefined && meterTotal > 0 ? { totalTokens: meterTotal } : {}),
        ...(opts.agentType !== undefined ? { agentType: opts.agentType } : {}),
        ...(opts.isolation !== undefined ? { isolation: opts.isolation } : {}),
        ...(extra !== undefined ? extra : {}),
      });
    };

    if (options.runLog && cacheKey !== undefined) {
      if (!cacheScope.chain.exhausted) {
        const cached = options.runLog.outputsByCacheKey.get(cacheKey);
        if (cached !== undefined && cached.result !== null) {
          const cachedPreview = trimWorkflowPreview(cached.result);
          emit("done", {
            cached: true,
            ...(cachedPreview !== undefined ? { resultPreview: cachedPreview } : {}),
          });
          return cloneWorkflowBoundaryValue(cached.result);
        }
        cacheScope.chain.exhausted = true;
      }
      const priorStarts = options.runLog.dispatchesByCacheKey.get(cacheKey);
      if (
        priorStarts !== undefined &&
        priorStarts.length > 0 &&
        !options.runLog.outputsByCacheKey.has(cacheKey)
      ) {
        options.log?.(
          `respawning agent "${label}" — previous attempt started but never completed (${priorStarts.length})`,
        );
      }
    }

    // Announce the agent before asking for a slot, so a fleet larger than the
    // concurrency limit shows every member waiting instead of only the few that
    // fit. The second emit is what turns the row from queued into running.
    emit("start", { queued: true });
    await gate.acquire(agentCtx.provider);
    emit("start");
    let emittedError = false;
    // A worktree-isolated agent owns ONE physical worktree for its whole logical
    // life: created before the retry loop, reused across every throttle/stall
    // attempt, and torn down once in the finally — after the journal result is
    // durable. Per-attempt cleanup would delete a clean tree between retries (so
    // a retry ran against drifted source) and drop the snapshot before the result
    // was recorded (so a crash-resume rebuilt from whatever the source held then).
    let managedWorktree: Worktree | null = null;
    let worktreeLease: WorktreeLease | null = null;
    try {
      if (!resolved.ok) throw toSandboxError(resolved.error);
      const profile = resolveWorkflowAgentProfile(opts.agentType, resolved.ctx);
      if (!profile.ok) throw toSandboxError(profile.error);
      if (opts.isolation === "worktree") {
        managedWorktree = await createWorktree(agentCtx.cwd, agentId);
        if (managedWorktree === null) {
          throw toSandboxError(
            "worktree isolation: failed to create or reuse the requested worktree",
          );
        }
        worktreeLease = await acquireWorktreeLease(managedWorktree.path);
      }
      // Record the dispatch before the fork so a crash mid-run is distinguishable
      // from a key that was never attempted.
      if (options.runLog && cacheKey !== undefined) {
        await options.runLog.persistRecord({
          type: "started",
          key: cacheKey,
          agentId,
        });
      }
      const runFork = forkRunnerOverride ?? options.runFork ?? defaultForkRunner;
      const meter = options.meter;
      const liveSink: ForkEventSink = (event) => {
        if (event.kind === "fork_usage") {
          if (event.isSnapshot) return;
          meter?.add(event.outputTokens);
          if (Number.isFinite(event.outputTokens) && event.outputTokens > 0) {
            agentOutputTokens += Math.floor(event.outputTokens);
          }
          emit("start");
          return;
        }
        if (event.kind === "fork_tool_dispatch_start") {
          transcripts.recordToolCall({
            agentId,
            name: event.toolName,
            toolInput: event.input,
          });
          emit("start");
          return;
        }
        if (event.kind === "fork_text_delta") {
          transcripts.appendText(agentId, event.text);
          return;
        }
        if (event.kind === "fork_stream_reset") {
          transcripts.discardText(agentId, event.discardedChars);
          return;
        }
        if (event.kind === "fork_complete") {
          transcripts.finalize(agentId, event.output);
        }
      };
      let forkOutcome: {
        result: SubagentResult;
        attempt: number;
        lastAttemptReason?: WorkflowAgentAttemptReason;
      } | null = null;
      let userRetries = 0;
      while (forkOutcome === null) {
        const agentController = new AbortController();
        const onParentAbort = (): void => agentController.abort(WORKFLOW_PARENT_ABORT_REASON);
        if (options.signal.aborted) agentController.abort(WORKFLOW_PARENT_ABORT_REASON);
        else
          options.signal.addEventListener("abort", onParentAbort, {
            once: true,
          });
        options.onAgentController?.(agentId, agentController);
        try {
          transcripts.begin(agentId, prompt);
          const forkRequest: WorkflowForkRequest = {
            // Sub-agents reason for real (effort inherited unless overridden), but
            // their reasoning summary is dropped where the provider can decouple it
            // so it is neither relayed to the parent nor accumulated as a re-sent
            // transcript. The parent reasons over the agent's output, not its
            // thinking.
            ctx: {
              ...agentCtx,
              abortSignal: agentController.signal,
              suppressThinkingSummary: true,
            },
            name: opts.agentType ?? "workflow-agent",
            body: profile.body,
            allowSet: profile.allowSet,
            extraDeclarations: profile.extraDeclarations,
            prompt,
            parentToolCallId: options.parentToolCallId,
            agentId,
            ...(isPlainObject(opts.schema) ? { outputSchema: opts.schema } : {}),
            ...(opts.isolation !== undefined ? { isolation: opts.isolation } : {}),
            // The owner-created worktree, reused verbatim across every retry.
            ...(managedWorktree !== null ? { worktree: managedWorktree } : {}),
            sink: liveSink,
          };
          const outcome = await runForkWithRetries(runFork, forkRequest, agentController.signal);
          const controlReason = agentController.signal.reason;
          // A manual workflow close aborts an in-flight fork with no structured output;
          // bail as cancellation before the schema validation below mistakes it for a
          // genuine missing-output failure.
          if (options.signal.aborted) {
            const preview = trimWorkflowPreview("Workflow was aborted.");
            emit("error", {
              stopped: true,
              ...(preview !== undefined ? { resultPreview: preview } : {}),
            });
            emittedError = true;
            throw toSandboxError("Workflow was aborted.");
          }
          if (!options.signal.aborted && controlReason === WORKFLOW_AGENT_SKIP_REASON) {
            emit("error", { skipped: true });
            return null;
          }
          if (
            !options.signal.aborted &&
            controlReason === WORKFLOW_AGENT_RETRY_REASON &&
            userRetries < WORKFLOW_MAX_USER_RETRIES
          ) {
            userRetries += 1;
          } else {
            forkOutcome = outcome;
          }
        } finally {
          options.signal.removeEventListener("abort", onParentAbort);
          options.onAgentController?.(agentId, null);
        }
      }
      const { result, attempt, lastAttemptReason } = forkOutcome;
      const attemptExtra =
        attempt > 1
          ? lastAttemptReason !== undefined
            ? { attempt, lastAttemptReason }
            : { attempt }
          : {};
      if (result.isError) {
        if (options.signal.aborted) {
          const preview = trimWorkflowPreview(result.output);
          emit("error", {
            stopped: true,
            ...attemptExtra,
            ...(preview !== undefined ? { resultPreview: preview } : {}),
          });
          emittedError = true;
          throw toSandboxError("Workflow was aborted.");
        }
        options.recordFailure?.(`${label}: ${result.output}`);
        const errorPreview = trimWorkflowPreview(result.output);
        emit("error", {
          ...attemptExtra,
          ...(errorPreview !== undefined ? { resultPreview: errorPreview } : {}),
        });
        emittedError = true;
        // A schema-contract failure is a script bug and must throw so the
        // author sees it. A terminal API/provider failure resolves to null —
        // the documented agent() contract — so a sequential `await agent()`
        // in a later phase still dispatches instead of the whole script dying
        // on one dead agent.
        if (result.stopReason === "error_max_structured_output_retries") {
          throw toSandboxError(
            `StructuredOutputMismatchError: Schema validation failed. ${result.output}`,
          );
        }
        if (result.output?.includes("StructuredOutput")) {
          throw toSandboxError(`StructuredOutputMismatchError: ${result.output}`);
        }
        return null;
      }
      let agentResult: unknown;
      if (opts.schema === undefined) {
        agentResult = result.output;
      } else if (result.structured !== undefined) {
        agentResult = cloneWorkflowBoundaryValue(result.structured);
      } else {
        options.recordFailure?.(`${label}: schema agent did not return structured output`);
        throw toSandboxError(
          `StructuredOutputMissingError: Schema was required but agent returned no structured output. Output: ${result.output}`,
        );
      }
      const donePreview =
        opts.schema === undefined
          ? trimWorkflowPreview(result.output)
          : trimWorkflowPreview(result.structured);
      if (options.runLog && cacheKey !== undefined && agentResult !== null) {
        const outputRecord: WorkflowOutputRecord = {
          type: "result",
          key: cacheKey,
          agentId,
          result: agentResult,
        };
        await options.runLog.persistRecord(outputRecord);
        options.runLog.outputsByCacheKey.set(cacheKey, outputRecord);
      }
      emit("done", {
        ...attemptExtra,
        ...(donePreview !== undefined ? { resultPreview: donePreview } : {}),
      });
      return agentResult;
    } catch (error) {
      const message = errorMessage(error);
      options.recordFailure?.(`${label}: ${message}`);
      const catchPreview = trimWorkflowPreview(message);
      if (!emittedError) {
        if (options.signal.aborted) {
          emit("error", {
            stopped: true,
            ...(catchPreview !== undefined ? { resultPreview: catchPreview } : {}),
          });
        } else {
          emit("error", catchPreview !== undefined ? { resultPreview: catchPreview } : undefined);
        }
        emittedError = true;
      }
      throw toSandboxError(error);
    } finally {
      // Single teardown after the journal result is durable: release the lease
      // first so the fail-closed guard doesn't block our own removal, then clean
      // up (preserved if the agent left changes in the worktree).
      if (worktreeLease) await worktreeLease.release();
      if (managedWorktree) await managedWorktree.cleanup();
      gate.release(agentCtx.provider);
    }
  };

  return { runAgent, agentCount: () => agentSeq };
}
