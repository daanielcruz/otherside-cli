/** Parses a provider error body into the wire fields classification reads. */
export interface ParsedWireError {
  eventType: string;
  code: string;
  type: string;
  status: string;
  reason: string;
  message: string;
  uiMessage: string;
  retryDelayMs: number | null;
  resetEpochMs: number | null;
  quotaId: string;
  domain: string;
  /** Where the account holder verifies the account before the provider serves it again. */
  verificationUrl: string;
}

export function parseWireError(body: string): ParsedWireError {
  const empty: ParsedWireError = {
    eventType: "",
    code: "",
    type: "",
    status: "",
    reason: "",
    message: "",
    uiMessage: "",
    retryDelayMs: null,
    resetEpochMs: null,
    quotaId: "",
    domain: "",
    verificationUrl: "",
  };
  if (body.trim().length === 0) return empty;
  try {
    const value = JSON.parse(body);
    const root = Array.isArray(value) ? value[0] : value;
    const rootRecord = record(root) ?? {};
    const response = record(rootRecord.response);
    const error =
      record(rootRecord.error) ??
      record(response?.error) ??
      record(rootRecord.base_resp) ??
      record(rootRecord.base_response) ??
      rootRecord;
    const errorText = typeof rootRecord.error === "string" ? rootRecord.error : "";
    // A refusal can arrive as a bare `detail` string with no error object.
    const detailText = typeof rootRecord.detail === "string" ? rootRecord.detail : "";
    const metadata = record(error.metadata) ?? {};
    const details = Array.isArray(error.details) ? error.details : [];
    // Some providers name the precise failure in a details object beside the type.
    const detailsCode = stringValue(record(error.details)?.error_code);
    let reason = stringValue(error.reason);
    let uiMessage = displayText(metadata.uiMessage);
    let retryDelayMs: number | null = null;
    let resetEpochMs: number | null = null;
    let quotaId = stringValue(metadata.quota_limit);
    let domain = "";
    let verificationUrl = "";
    for (const rawDetail of details) {
      const detail = record(rawDetail);
      if (!detail) continue;
      const detailMetadata = record(detail.metadata) ?? {};
      reason ||= stringValue(detail.reason);
      uiMessage ||= displayText(detailMetadata.uiMessage);
      domain ||= stringValue(detail.domain);
      verificationUrl ||=
        stringValue(detailMetadata.validation_url) ||
        stringValue(detailMetadata.validation_link) ||
        helpLinkUrl(detail.links);
      quotaId ||= stringValue(detailMetadata.quota_limit);
      retryDelayMs ??= durationMs(detail.retryDelay ?? detail.retry_delay);
      resetEpochMs ??= quotaResetFrom(detailMetadata);
      const violations = Array.isArray(detail.violations) ? detail.violations : [];
      for (const rawViolation of violations) {
        const violation = record(rawViolation);
        if (violation) quotaId ||= stringValue(violation.quotaId);
      }
    }
    const resetAt = numberValue(error.resets_at) ?? numberValue(metadata.resets_at);
    const resetsIn = numberValue(error.resets_in_seconds);
    const message = stringValue(
      error.message || error.msg || error.status_msg || errorText || detailText,
    );
    return {
      eventType: stringValue(rootRecord.type),
      code:
        stringValue(error.code || error.status_code || error.error_code) ||
        detailsCode ||
        trailingCode(message),
      type: stringValue(error.type),
      status: stringValue(error.status),
      reason,
      message,
      uiMessage,
      retryDelayMs,
      resetEpochMs:
        resetAt !== null
          ? resetAt * 1000
          : resetsIn !== null
            ? Date.now() + resetsIn * 1000
            : resetEpochMs,
      quotaId,
      domain,
      verificationUrl,
    };
  } catch {
    return empty;
  }
}

/**
 * A display message. `"true"` and `"false"` are flags that say whether to show
 * the error's own message, so they are never text to show.
 */
function displayText(value: unknown): string {
  const text = stringValue(value);
  return text === "true" || text === "false" ? "" : text;
}

/** A code some providers append to the message itself, as in `… (2056)`. */
function trailingCode(message: string): string {
  return message.match(/\((\d{4,5})\)\s*$/)?.[1] ?? "";
}

function helpLinkUrl(links: unknown): string {
  if (!Array.isArray(links)) return "";
  return stringValue(record(links[0])?.url);
}

/** When a spent quota resets, from the stamp or the delay the error carries. */
function quotaResetFrom(metadata: Record<string, unknown>): number | null {
  const stamp = stringValue(metadata.quotaResetTimeStamp);
  const at = stamp ? Date.parse(stamp) : Number.NaN;
  if (Number.isFinite(at)) return at;
  const delay = durationMs(metadata.quotaResetDelay);
  return delay === null ? null : Date.now() + delay;
}

function durationMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)$/);
  if (!match?.[1] || !match[2]) return null;
  const unitMs: Readonly<Record<string, number>> = {
    ns: 0.000_001,
    us: 0.001,
    µs: 0.001,
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
  };
  return Math.round(Number(match[1]) * (unitMs[match[2]] ?? 0));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
