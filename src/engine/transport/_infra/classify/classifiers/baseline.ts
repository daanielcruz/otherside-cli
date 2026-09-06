import { isRetryableNetworkError, ProviderHttpError } from "@/engine/providers/_shared/retry.ts";
import type {
  ErrorClassifier,
  ErrorClassifierInput,
} from "@/engine/transport/_infra/classify/error-classifier.ts";
import type {
  ErrorAction,
  ErrorActionId,
  ErrorMeta,
  ProviderContext,
} from "@/engine/transport/error-meta.ts";

const ACTION_LABELS: Record<ErrorActionId, string> = {
  retry: "Retry",
  "switch-model": "Switch model",
  compact: "Run /compact",
  "continue-anyway": "Continue anyway",
  cancel: "Cancel",
};

function actions(...ids: ErrorActionId[]): ErrorAction[] {
  return ids.map((id) => ({ id, label: ACTION_LABELS[id] }));
}

const DEAD_STREAM_PATTERN = /response had no body|stream closed before|socket error/i;
const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 429, 529]);

function isRetryableHttp(err: unknown): boolean {
  if (!(err instanceof ProviderHttpError)) return false;
  if (RETRYABLE_HTTP_STATUSES.has(err.status)) return true;
  return err.status >= 500 && err.status < 600;
}

function rawText(input: ErrorClassifierInput): string {
  const { err, decision } = input;
  const fromDecision = decision.kind === "fail" ? decision.message : undefined;
  const fromErr = err instanceof Error ? err.message : undefined;
  return fromDecision ?? fromErr ?? String(err);
}

function buildContext(input: ErrorClassifierInput): ProviderContext {
  const { decision, provider, model, attempt } = input;
  return {
    provider,
    model,
    status: decision.kind === "fail" ? decision.status : undefined,
    attempt,
    resetEpochMs: decision.kind === "fail" ? (decision.quotaResetEpochMs ?? null) : null,
  };
}

export function classifyBaseline(input: ErrorClassifierInput): ErrorMeta {
  const { err, decision, provider, source } = input;
  const rawDetail = rawText(input);
  const providerContext = buildContext(input);
  const base = { source, rawDetail, providerContext } as const;

  if (decision.kind === "fail" && decision.quotaExhausted === true) {
    return {
      ...base,
      errorClass: "quota-rate-limit",
      modal: true,
      retryable: false,
      title: "Quota / rate limit reached",
      summary: decision.userMessage ?? "Switch model or wait for the limit to reset.",
      actions: actions("switch-model", "cancel"),
    };
  }

  if (decision.kind === "fail" && decision.reason === "context_window_exceeded") {
    return {
      ...base,
      errorClass: "context-window",
      modal: true,
      retryable: false,
      title: "Context window exceeded",
      summary:
        decision.userMessage ?? "Run /compact or switch to a model with a larger context window.",
      actions: actions("compact", "switch-model", "cancel"),
    };
  }

  if (err instanceof ProviderHttpError && err.status === 401) {
    return {
      ...base,
      errorClass: "auth",
      modal: true,
      retryable: false,
      title: "Authentication expired",
      summary: `Session expired — run \`otherside login --provider ${provider}\`.`,
      actions: actions("cancel"),
    };
  }

  if (
    source === "stream-retry" &&
    (isRetryableHttp(err) || (err instanceof Error && DEAD_STREAM_PATTERN.test(err.message)))
  ) {
    return {
      ...base,
      errorClass: "api-retryable-exhausted",
      modal: true,
      retryable: true,
      title: "The request failed after repeated attempts",
      summary:
        "The model request did not complete. Retry with the same history, switch model, or cancel.",
      actions: actions("retry", "switch-model", "cancel"),
    };
  }

  if (isRetryableNetworkError(err)) {
    return {
      ...base,
      errorClass: "network-transient",
      modal: true,
      retryable: true,
      title: "Network error",
      summary: "A transient network error interrupted the request.",
      actions: actions("retry", "cancel"),
    };
  }

  if (source === "turn-loop") {
    const loop = classifyLoopHalt(base, rawDetail, decision);
    if (loop) return loop;
  }

  if (source === "subagent") {
    return {
      ...base,
      errorClass: "subagent-background",
      modal: false,
      retryable: false,
      title: "Background task error",
      summary: rawDetail,
      actions: [],
    };
  }

  if (source === "tool-pipeline") {
    return {
      ...base,
      errorClass: "tool",
      modal: false,
      retryable: false,
      title: "Tool error",
      summary: rawDetail,
      actions: [],
    };
  }

  return {
    ...base,
    errorClass: "other",
    modal: true,
    retryable: false,
    title: "Something went wrong",
    summary: decision.kind === "fail" ? (decision.userMessage ?? fallbackSummary) : fallbackSummary,
    actions: actions("retry", "cancel"),
  };
}

const fallbackSummary = "An unexpected error occurred.";

function classifyLoopHalt(
  base: Pick<ErrorMeta, "source" | "rawDetail" | "providerContext">,
  raw: string,
  decision: ErrorClassifierInput["decision"],
): ErrorMeta | null {
  if (/empty response again/i.test(raw)) {
    return {
      ...base,
      errorClass: "loop-halt",
      modal: true,
      retryable: true,
      title: "Model returned an empty response",
      summary: raw,
      actions: actions("retry", "switch-model", "cancel"),
    };
  }
  if (/stop hook blocked/i.test(raw)) {
    return {
      ...base,
      errorClass: "loop-halt",
      modal: true,
      retryable: true,
      title: "Stop hook keeps blocking",
      summary: raw,
      actions: actions("continue-anyway", "cancel"),
    };
  }
  if (/compaction cannot help/i.test(raw)) {
    return {
      ...base,
      errorClass: "context-window",
      modal: true,
      retryable: false,
      title: "Context window exceeded — compaction can't help",
      summary:
        (decision.kind === "fail" ? decision.userMessage : undefined) ??
        "The system prompt, tool definitions, and attachments alone exceed the window. Switch to a model with a larger context window or start a new session.",
      actions: actions("switch-model", "cancel"),
    };
  }
  if (/context too large/i.test(raw)) {
    return {
      ...base,
      errorClass: "context-window",
      modal: true,
      retryable: false,
      title: "Context window exceeded",
      summary:
        (decision.kind === "fail" ? decision.userMessage : undefined) ??
        "Run /compact or switch to a model with a larger context window.",
      actions: actions("compact", "switch-model", "cancel"),
    };
  }
  if (/runaway turn aborted/i.test(raw)) {
    return {
      ...base,
      errorClass: "loop-halt",
      modal: true,
      retryable: false,
      title: "Turn aborted (runaway output)",
      summary: raw,
      actions: actions("cancel"),
    };
  }
  return null;
}

export const baselineClassifier: ErrorClassifier = {
  id: "baseline",
  classify: classifyBaseline,
};
