import { maxStructuredOutputRetries } from "@/engine/background/subagents/fork/structured-retries.ts";
import {
  STRUCTURED_OUTPUT_FORCING_INSTRUCTION,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from "@/engine/background/subagents/structured-output.ts";
import {
  list as listBackgroundTasks,
  subscribe as subscribeBackgroundTasks,
} from "@/engine/background/tasks/background.ts";
import {
  listWorkflowTasks,
  subscribeWorkflowTasks,
} from "@/engine/background/workflows/runtime/store/store.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import type { Agent } from "@/engine/queue/index.ts";
import { takeHeadlessDenials } from "@/engine/queue/runtime/headless-denials.ts";
import type { TurnObserver } from "@/engine/queue/turn/observer.ts";
import { runSessionTurn } from "@/engine/queue/turn/run-session.ts";
import { costFor } from "@/engine/session/usage/pricing.ts";
import { getMcpServerStatuses } from "@/kernel/mcp/runtime/manager.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import { permissionModeToWire } from "@/modes/args.ts";
import {
  applyPrintSessionFlags,
  installSystemPromptProvider,
  numericCliEnv,
  printProviderId,
  readJsonSchemaEnv,
} from "./flags.ts";
import { isProviderEvent, sdkToolName, shouldEmitProviderEvents } from "./sdk-compat.ts";
import { installPrintSessionResources } from "./session-resources.ts";
import {
  acceptStructuredOutput,
  createStructuredOutputState,
  installStructuredOutputProvider,
  installStructuredOutputTool,
  STRUCTURED_OUTPUT_NUDGE_MESSAGE,
  structuredRetryMessage,
} from "./structured-output.ts";
import type { PrintOutputFormat, PrintRuntime } from "./types.ts";

export type { PrintOutputFormat, PrintRuntime } from "./types.ts";

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function shouldRetryWithFallback(error: string | null, fallbackModel: string | undefined): boolean {
  if (error === null || !fallbackModel) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes("rate limit") ||
    lower.includes("overload") ||
    lower.includes("overloaded") ||
    lower.includes("429") ||
    lower.includes("503")
  );
}

function hasBlockingPrintTask(): boolean {
  if (
    listBackgroundTasks().some(
      (task) =>
        task.ownerId === undefined &&
        task.kind === "agent" &&
        task.isBackgrounded &&
        task.status === "running",
    )
  ) {
    return true;
  }
  return listWorkflowTasks().some(
    (task) => task.ownerId === undefined && task.status === "running",
  );
}

function waitForPrintTaskChange(): Promise<void> {
  if (emitQueue.hasPendingAutoTurn() || !hasBlockingPrintTask()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    let unsubscribeBackground = (): void => {};
    let unsubscribeWorkflow = (): void => {};
    let unsubscribeQueue = (): void => {};
    const check = (): void => {
      if (settled) return;
      if (!emitQueue.hasPendingAutoTurn() && hasBlockingPrintTask()) return;
      settled = true;
      unsubscribeBackground();
      unsubscribeWorkflow();
      unsubscribeQueue();
      resolve();
    };
    unsubscribeBackground = subscribeBackgroundTasks(check);
    unsubscribeWorkflow = subscribeWorkflowTasks(check);
    unsubscribeQueue = emitQueue.subscribe(check);
    check();
  });
}

export async function runPrintMode(
  agent: Agent,
  prompt: string,
  outputFormat: PrintOutputFormat,
  runtime: PrintRuntime,
  trace: (msg: string) => void = () => {},
): Promise<number> {
  if (prompt.trim().length === 0) {
    process.stderr.write(
      "Error: Input must be provided either through stdin or as a prompt argument when using --print\n",
    );
    return 1;
  }
  if (outputFormat === "stream-json" && !runtime.verbose) {
    process.stderr.write(
      "Error: When using --print, --output-format=stream-json requires --verbose\n",
    );
    return 1;
  }

  const jsonSchemaEnv = readJsonSchemaEnv();
  if (jsonSchemaEnv.error !== null) {
    process.stderr.write(`Error: ${jsonSchemaEnv.error}\n`);
    return 1;
  }
  const structuredOutput =
    jsonSchemaEnv.schema === null
      ? { state: null, error: null }
      : createStructuredOutputState(jsonSchemaEnv.schema);
  if (structuredOutput.error !== null) {
    process.stderr.write(`Error: Invalid --json-schema: ${structuredOutput.error}\n`);
    return 1;
  }
  const structuredState = structuredOutput.state;

  const sessionId = applyPrintSessionFlags(agent, runtime);
  const installed = await installPrintSessionResources(runtime);
  if (installed.error !== null || installed.resources === null) {
    process.stderr.write(`Error: Invalid print session configuration: ${installed.error}\n`);
    return 1;
  }
  const maxBudgetUsd = numericCliEnv("OTHERSIDE_CLI_MAX_BUDGET_USD");
  const fallbackModel = process.env.OTHERSIDE_CLI_FALLBACK_MODEL;
  const restoreStructuredProvider =
    structuredState === null
      ? () => {}
      : installStructuredOutputProvider(printProviderId(agent), structuredState.schema);
  const restoreStructuredTool =
    structuredState === null ? () => {} : installStructuredOutputTool(structuredState);
  const restoreProvider = installSystemPromptProvider(agent);
  const startMs = Date.now();
  const sessionToolNames = uniqueStrings([
    ...runtime.toolNames,
    ...installed.resources.toolNames,
    ...(structuredState === null ? [] : [STRUCTURED_OUTPUT_TOOL_NAME]),
  ]);
  const sessionAgentNames = uniqueStrings([
    ...runtime.agentNames,
    ...installed.resources.agentNames,
  ]);
  const sessionMcpStatuses = [
    ...getMcpServerStatuses(runtime.mcpServers),
    ...installed.resources.mcpStatuses,
  ];
  const events: unknown[] = [];
  const emit = (event: Record<string, unknown>): void => {
    if (outputFormat === "stream-json") {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    } else if (outputFormat === "json") {
      events.push(event);
    }
  };

  if (outputFormat !== "text") {
    emit({
      type: "system",
      subtype: "init",
      cwd: runtime.cwd,
      session_id: sessionId,
      tools: sessionToolNames.map(sdkToolName),
      mcp_servers: sessionMcpStatuses,
      model: runtime.model,
      permissionMode: permissionModeToWire(runtime.permissionMode),
      slash_commands: runtime.slashCommands,
      agents: sessionAgentNames,
      skills: runtime.skillNames,
      apiKeySource: "none",
      output_style: "default",
      fast_mode_state: "off",
      otherside_version: runtime.version,
      uuid: uuidv4(),
    });
  }

  // Both the result envelope and text mode report only the LAST turn's assistant
  // text (a tool-using run overwrites per assistant message, not appends).
  let lastAssistantText = "";
  let turnText = "";
  let inputTokensSum = 0;
  let outputTokensSum = 0;
  let cacheReadSum = 0;
  let cacheCreationSum = 0;
  let httpTurns = 0;
  let hitMaxTurns = false;
  let hitBudget = false;
  let hitStructuredOutputRetries = false;
  let lastError: string | null = null;
  let stopReason = "stop";
  let durationApiMs = 0;

  let turnInput: number | null = null;
  let turnOutput: number | null = null;
  let turnCacheRead: number | null = null;
  let turnCacheCreation: number | null = null;
  let turnContent: Array<Record<string, unknown>> = [];
  let turnApiStartMs = 0;
  let pendingThinkingText = "";
  let pendingThinkingSignature = "";
  let pendingTextChunk = "";
  let pendingToolResults: Array<Record<string, unknown>> = [];

  const flushPendingThinking = (): void => {
    if (pendingThinkingText.length === 0 && pendingThinkingSignature.length === 0) return;
    const block: Record<string, unknown> = {
      type: "thinking",
      thinking: pendingThinkingText,
    };
    if (pendingThinkingSignature) block.signature = pendingThinkingSignature;
    turnContent.push(block);
    pendingThinkingText = "";
    pendingThinkingSignature = "";
  };
  const flushPendingText = (): void => {
    if (pendingTextChunk.length === 0) return;
    turnContent.push({ type: "text", text: pendingTextChunk });
    pendingTextChunk = "";
  };
  const commitTurnUsage = (): void => {
    if (turnInput !== null) inputTokensSum += turnInput;
    if (turnOutput !== null) outputTokensSum += turnOutput;
    if (turnCacheRead !== null) cacheReadSum += turnCacheRead;
    if (turnCacheCreation !== null) cacheCreationSum += turnCacheCreation;
    turnInput = null;
    turnOutput = null;
    turnCacheRead = null;
    turnCacheCreation = null;
  };
  const currentTotalCostUsd = (): number =>
    runtime.pricing
      ? costFor(
          {
            inputTokens: inputTokensSum,
            outputTokens: outputTokensSum,
            cacheReadInputTokens: cacheReadSum,
          },
          runtime.pricing,
        ).total
      : 0;
  const flushUserToolResults = (): void => {
    if (pendingToolResults.length === 0) return;
    if (outputFormat !== "text") {
      emit({
        type: "user",
        message: { role: "user", content: pendingToolResults },
        parent_tool_use_id: null,
        session_id: sessionId,
        uuid: uuidv4(),
      });
    }
    pendingToolResults = [];
  };

  const emitProviderEvents = shouldEmitProviderEvents(outputFormat);
  const observer: TurnObserver = {
    onAny: (event) => {
      trace(`event ${event.kind}`);
      if (!emitProviderEvents || !isProviderEvent(event)) return;
      emit({
        type: "stream_event",
        event,
        parent_tool_use_id: null,
        session_id: sessionId,
        uuid: uuidv4(),
      });
    },
    turn_start: () => {
      flushUserToolResults();
      turnContent = [];
      turnApiStartMs = Date.now();
    },
    stream_reset: () => {
      // The failed attempt re-streams from scratch: void everything it
      // accumulated so the emitted assistant message and the final `result`
      // don't carry partial+full doubled text. Text mode buffers (final-only),
      // so nothing was printed yet — the reset is clean.
      turnText = "";
      turnContent = [];
      pendingTextChunk = "";
      pendingThinkingText = "";
      pendingThinkingSignature = "";
    },
    text_delta: (event) => {
      flushPendingThinking();
      pendingTextChunk += event.text;
      turnText += event.text;
    },
    thinking_delta: (event) => {
      flushPendingText();
      pendingThinkingText += event.text;
    },
    thinking_signature: (event) => {
      pendingThinkingSignature = event.signature;
    },
    tool_call_complete: (event) => {
      flushPendingThinking();
      flushPendingText();
      if (structuredState !== null && event.name === STRUCTURED_OUTPUT_TOOL_NAME) {
        structuredState.lastInput = event.input;
      }
      turnContent.push({
        type: "tool_use",
        id: event.id,
        name: event.name,
        input: event.input,
      });
    },
    usage: (event) => {
      if (typeof event.inputTokens === "number") turnInput = event.inputTokens;
      if (typeof event.outputTokens === "number") turnOutput = event.outputTokens;
      if (typeof event.cacheReadInputTokens === "number")
        turnCacheRead = event.cacheReadInputTokens;
      if (typeof event.cacheCreationInputTokens === "number")
        turnCacheCreation = event.cacheCreationInputTokens;
    },
    message_stop: (event) => {
      flushPendingThinking();
      flushPendingText();
      httpTurns += 1;
      stopReason = event.stop_reason;
      lastAssistantText = turnText;
      turnText = "";
      durationApiMs += Date.now() - turnApiStartMs;
      // --max-turns: once N assistant turns complete, stop the agent before the
      // next one starts (enforced print-side; the loop returns on cancel).
      if (runtime.maxTurns !== null && httpTurns >= runtime.maxTurns) {
        hitMaxTurns = true;
        agent.cancel();
      }
      if (outputFormat !== "text" && turnContent.length > 0) {
        emit({
          type: "assistant",
          message: {
            model: runtime.model,
            id: `msg_${uuidv4().replace(/-/g, "").slice(0, 24)}`,
            type: "message",
            role: "assistant",
            content: turnContent,
            stop_reason: event.stop_reason,
            stop_sequence: null,
            usage: {
              input_tokens: turnInput ?? 0,
              cache_creation_input_tokens: turnCacheCreation ?? 0,
              cache_read_input_tokens: turnCacheRead ?? 0,
              output_tokens: turnOutput ?? 0,
              service_tier: "standard",
            },
          },
          parent_tool_use_id: null,
          session_id: sessionId,
          uuid: uuidv4(),
        });
      }
      commitTurnUsage();
      if (maxBudgetUsd !== null && currentTotalCostUsd() > maxBudgetUsd) {
        hitBudget = true;
        agent.cancel();
      }
      turnContent = [];
    },
    tool_dispatch_complete: (event) => {
      if (structuredState !== null && event.name === STRUCTURED_OUTPUT_TOOL_NAME) {
        if (event.isError) {
          structuredState.lastError = event.content;
        } else if (!structuredState.consumed) {
          const accepted = acceptStructuredOutput(structuredState, structuredState.lastInput ?? {});
          if (accepted.ok) agent.cancel?.();
        } else {
          agent.cancel?.();
        }
      }
      pendingToolResults.push({
        tool_use_id: event.id,
        type: "tool_result",
        content: event.content,
        ...(event.isError ? { is_error: true } : {}),
      });
    },
    turn_end: () => {
      flushUserToolResults();
    },
    error: (event) => {
      lastError = event.error;
    },
    quota_exhausted: (event) => {
      // Terminal for the run either way (plan quota or spent rate-limit
      // retries): without this, the turn ends "successfully" with empty
      // output and exit 0 — and the --fallback-model retry never triggers.
      lastError = event.message;
    },
  };

  const continueForAsyncTasks = async (): Promise<void> => {
    while (
      !hitMaxTurns &&
      !hitBudget &&
      lastError === null &&
      (hasBlockingPrintTask() || emitQueue.hasPendingAutoTurn())
    ) {
      if (!emitQueue.hasPendingAutoTurn()) {
        await waitForPrintTaskChange();
        continue;
      }
      await runSessionTurn(agent.runTurn(""), observer);
    }
  };

  trace("opening agent.runTurn");
  try {
    try {
      if (structuredState !== null)
        agent.pushInjectionInMemoryOnly?.(STRUCTURED_OUTPUT_FORCING_INSTRUCTION);
      await runSessionTurn(agent.runTurn(prompt), observer);
      await continueForAsyncTasks();
      const maxStructuredRetries = maxStructuredOutputRetries();
      while (
        structuredState !== null &&
        !structuredState.consumed &&
        !hitMaxTurns &&
        !hitBudget &&
        lastError === null &&
        structuredState.retries < maxStructuredRetries
      ) {
        structuredState.retries += 1;
        if (agent.pushInjectionInMemoryOnly) {
          agent.pushInjectionInMemoryOnly(STRUCTURED_OUTPUT_NUDGE_MESSAGE);
          await runSessionTurn(agent.runTurn(""), observer);
        } else {
          await runSessionTurn(agent.runTurn(STRUCTURED_OUTPUT_NUDGE_MESSAGE), observer);
        }
        await continueForAsyncTasks();
      }
      if (
        structuredState !== null &&
        !structuredState.consumed &&
        !hitMaxTurns &&
        !hitBudget &&
        lastError === null
      ) {
        hitStructuredOutputRetries = true;
        lastError = structuredRetryMessage(structuredState, maxStructuredRetries);
      }
      if (fallbackModel && shouldRetryWithFallback(lastError, fallbackModel)) {
        trace(`retrying with fallback model: ${fallbackModel}`);
        lastError = null;
        lastAssistantText = "";
        turnText = "";
        turnContent = [];
        pendingTextChunk = "";
        pendingThinkingText = "";
        pendingThinkingSignature = "";
        turnInput = null;
        turnOutput = null;
        turnCacheRead = null;
        turnCacheCreation = null;
        agent.cancelled = false;
        agent.deps.broker.dispatch({ kind: "set_model", model: fallbackModel });
        await runSessionTurn(agent.runTurn(prompt), observer);
        await continueForAsyncTasks();
      }
      flushUserToolResults();
      commitTurnUsage();
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      trace(`runTurn threw: ${lastError}`);
    }
  } finally {
    restoreProvider();
    restoreStructuredProvider();
    restoreStructuredTool();
    await installed.resources.close();
  }
  trace(`runTurn complete; text-bytes=${lastAssistantText.length}`);

  const durationMs = Date.now() - startMs;
  const totalCostUsd = currentTotalCostUsd();

  const maxTurnsMessage = hitMaxTurns ? `Reached max turns (${runtime.maxTurns})` : null;
  const budgetMessage = hitBudget ? `Exceeded USD budget (${maxBudgetUsd})` : null;
  const runError = maxTurnsMessage ?? budgetMessage ?? lastError;
  const isError = runError !== null;
  const subtype = hitMaxTurns
    ? "error_max_turns"
    : hitBudget
      ? "error_max_budget_usd"
      : hitStructuredOutputRetries
        ? "error_max_structured_output_retries"
        : lastError
          ? "error_during_execution"
          : "success";

  if (outputFormat === "text") {
    // Final-only: the buffered last-turn result is printed once after the run
    // (no live deltas). On failure, the fixed subtype string, with the concrete
    // reason on stderr for diagnostics.
    if (hitMaxTurns) {
      process.stdout.write(`Error: Reached max turns (${runtime.maxTurns})`);
      return 1;
    }
    if (hitBudget) {
      process.stdout.write(`Error: Exceeded USD budget (${maxBudgetUsd})`);
      return 1;
    }
    if (hitStructuredOutputRetries) {
      process.stdout.write(
        "Error: Failed to provide valid structured output after maximum retries",
      );
      return 1;
    }
    if (lastError) {
      process.stdout.write("Execution error");
      process.stderr.write(`error: ${lastError}\n`);
      return 1;
    }
    process.stdout.write(
      lastAssistantText.endsWith("\n") ? lastAssistantText : `${lastAssistantText}\n`,
    );
    return 0;
  }

  const resultFrame: Record<string, unknown> = {
    type: "result",
    subtype,
    is_error: isError,
    api_error_status: null,
    duration_ms: durationMs,
    duration_api_ms: durationApiMs,
    num_turns: httpTurns,
    result: isError ? "" : lastAssistantText,
    stop_reason: stopReason,
    session_id: sessionId,
    total_cost_usd: totalCostUsd,
    usage: {
      input_tokens: inputTokensSum,
      cache_creation_input_tokens: cacheCreationSum,
      cache_read_input_tokens: cacheReadSum,
      output_tokens: outputTokensSum,
      service_tier: "standard",
    },
    modelUsage: {
      [runtime.model]: {
        inputTokens: inputTokensSum,
        outputTokens: outputTokensSum,
        cacheReadInputTokens: cacheReadSum,
        cacheCreationInputTokens: cacheCreationSum,
        webSearchRequests: 0,
        costUSD: totalCostUsd,
        contextWindow: runtime.contextWindow,
      },
    },
    permission_denials: takeHeadlessDenials(sessionId),
    terminal_reason: hitMaxTurns
      ? "max_turns"
      : hitBudget
        ? "max_budget_usd"
        : isError
          ? "error"
          : "completed",
    fast_mode_state: "off",
    uuid: uuidv4(),
    ...(structuredState?.consumed ? { structured_output: structuredState.value } : {}),
    ...(runError !== null ? { errors: [runError] } : {}),
  };
  emit(resultFrame);

  if (outputFormat === "json") {
    // Non-verbose json prints only the final result object (so `jq .result`
    // works); --verbose prints the full frame array.
    const payload = runtime.verbose ? events : resultFrame;
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  return isError ? 1 : 0;
}
