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
    const metadata = record(error.metadata) ?? {};
    const details = Array.isArray(error.details) ? error.details : [];
    let reason = stringValue(error.reason);
    let uiMessage = stringValue(metadata.uiMessage);
    let retryDelayMs: number | null = null;
    let quotaId = "";
    let domain = "";
    for (const rawDetail of details) {
      const detail = record(rawDetail);
      if (!detail) continue;
      const detailMetadata = record(detail.metadata) ?? {};
      reason ||= stringValue(detail.reason);
      uiMessage ||= stringValue(detailMetadata.uiMessage);
      domain ||= stringValue(detail.domain);
      retryDelayMs ??= durationMs(detail.retryDelay ?? detail.retry_delay);
      const violations = Array.isArray(detail.violations) ? detail.violations : [];
      for (const rawViolation of violations) {
        const violation = record(rawViolation);
        if (violation) quotaId ||= stringValue(violation.quotaId);
      }
    }
    const resetAt = numberValue(error.resets_at) ?? numberValue(metadata.resets_at);
    const resetsIn = numberValue(error.resets_in_seconds);
    return {
      eventType: stringValue(rootRecord.type),
      code: stringValue(error.code || error.status_code || error.error_code),
      type: stringValue(error.type),
      status: stringValue(error.status),
      reason,
      message: stringValue(error.message || error.msg || error.status_msg || errorText),
      uiMessage,
      retryDelayMs,
      resetEpochMs:
        resetAt !== null ? resetAt * 1000 : resetsIn !== null ? Date.now() + resetsIn * 1000 : null,
      quotaId,
      domain,
    };
  } catch {
    return empty;
  }
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
