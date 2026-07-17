export type ErrorKind =
  | "api-retryable-exhausted"
  | "quota-rate-limit"
  | "loop-halt"
  | "network-transient"
  | "auth"
  | "context-window"
  | "tool"
  | "subagent-background"
  | "hook"
  | "other";

export const ERROR_KIND_HTTP_STATUS: Readonly<Record<ErrorKind, number | null>> = {
  "api-retryable-exhausted": 502,
  "quota-rate-limit": 429,
  "loop-halt": null,
  "network-transient": 503,
  auth: 401,
  "context-window": 413,
  tool: null,
  "subagent-background": null,
  hook: null,
  other: null,
} as const;

export class QuotaExhaustedError extends Error {
  provider: string;
  model: string;
  resetEpochMs: number | null;
  constructor(opts: {
    provider: string;
    model: string;
    resetEpochMs: number | null;
    message: string;
  }) {
    super(opts.message);
    this.name = "QuotaExhaustedError";
    this.provider = opts.provider;
    this.model = opts.model;
    this.resetEpochMs = opts.resetEpochMs;
  }
}

export class ProviderHttpError extends Error {
  provider: string;
  status: number;
  body: string;
  retryAfterHeader: string | null;
  shouldRetryHeader: string | null;
  headers: Record<string, string>;
  quotaExhausted: boolean;
  quotaResetEpochMs: number | null;
  constructor(opts: {
    provider: string;
    status: number;
    body: string;
    retryAfterHeader?: string | null;
    shouldRetryHeader?: string | null;
    headers?: Headers | Record<string, string | null | undefined>;
    quotaExhausted?: boolean;
    quotaResetEpochMs?: number | null;
  }) {
    const preview = opts.body.length > 500 ? `${opts.body.slice(0, 500)}…` : opts.body;
    super(`HTTP ${opts.status} from ${opts.provider}: ${preview}`);
    this.name = "ProviderHttpError";
    this.provider = opts.provider;
    this.status = opts.status;
    this.body = opts.body;
    this.headers = normalizeHeaders(opts.headers);
    this.retryAfterHeader = opts.retryAfterHeader ?? this.headers["retry-after"] ?? null;
    this.shouldRetryHeader = opts.shouldRetryHeader ?? this.headers["x-should-retry"] ?? null;
    if (this.retryAfterHeader !== null) this.headers["retry-after"] = this.retryAfterHeader;
    if (this.shouldRetryHeader !== null) this.headers["x-should-retry"] = this.shouldRetryHeader;
    this.quotaExhausted = opts.quotaExhausted ?? false;
    this.quotaResetEpochMs = opts.quotaResetEpochMs ?? null;
  }
}

function normalizeHeaders(
  headers: Headers | Record<string, string | null | undefined> | undefined,
): Record<string, string> {
  if (!headers) return {};
  const normalized: Record<string, string> = {};
  if (typeof (headers as Headers).forEach === "function") {
    (headers as Headers).forEach((value, key) => {
      normalized[key.toLowerCase()] = value;
    });
    return normalized;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value !== null && value !== undefined) normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

export type ErrorClass = ErrorKind;

export type ErrorActionId = "retry" | "switch-model" | "compact" | "continue-anyway" | "cancel";

export interface ErrorAction {
  id: ErrorActionId;
  label: string;
}

export interface ProviderContext {
  provider?: string | undefined;
  model?: string | undefined;
  status?: number | undefined;
  attempt?: number | undefined;
  resetEpochMs?: number | null | undefined;
}

export interface ErrorMeta {
  source:
    | "stream-retry"
    | "turn-loop"
    | "tool-pipeline"
    | "hook"
    | "subagent"
    | "compaction"
    | "transport";
  errorClass: ErrorClass;
  modal: boolean;
  retryable: boolean;
  title: string;
  summary: string;
  rawDetail: string;
  actions: ErrorAction[];
  providerContext?: ProviderContext;
}
