const DEFAULT_BACKEND_URL = "https://api.othersidecli.com";

function isAllowedBackendHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  if (hostname === "othersidecli.com" || hostname.endsWith(".othersidecli.com")) return true;
  return false;
}

let warnedRejectedOverride = false;

/** Public base URL of the cortex broker (HTTP + Socket.IO origin). */
export function cortexUrl(): string {
  const override = process.env.OTHERSIDE_CORTEX_URL ?? process.env.OTHERSIDE_BACKEND_URL;
  if (!override) return DEFAULT_BACKEND_URL;
  try {
    const parsed = new URL(override);
    const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    const schemeOk = parsed.protocol === "https:" || (parsed.protocol === "http:" && isLocal);
    if (schemeOk && isAllowedBackendHost(parsed.hostname)) return override.replace(/\/+$/, "");
  } catch {
    /* fall through */
  }
  if (!warnedRejectedOverride) {
    warnedRejectedOverride = true;
    process.stderr.write(
      `remote: backend URL override rejected (host not in allowlist), using ${DEFAULT_BACKEND_URL}\n`,
    );
  }
  return DEFAULT_BACKEND_URL;
}

export type CortexClient = "cli" | "app" | "design_web";

export interface CortexSuccess<T> {
  status: "success";
  data: T;
  request_id: string;
}

export interface CortexErrorBody {
  status: "error";
  error_code: string;
  message: string;
  request_id: string;
}

export class CortexApiError extends Error {
  readonly code: string;
  readonly requestId: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, requestId: string, httpStatus = 0) {
    super(message);
    this.name = "CortexApiError";
    this.code = code;
    this.requestId = requestId;
    this.httpStatus = httpStatus;
  }
}

export interface CortexFetchOpts {
  method?: string;
  token?: string;
  body?: unknown;
  idempotencyKey?: string;
  client?: CortexClient;
  signal?: AbortSignal;
  /** When true, return raw Response without envelope parse (rare). */
  raw?: boolean;
}

export async function cortexFetch<T>(path: string, opts: CortexFetchOpts = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = {
    "X-Request-ID": crypto.randomUUID(),
    "X-Otherside-Client": opts.client ?? "cli",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  else if (method !== "GET" && method !== "HEAD") {
    headers["Idempotency-Key"] = crypto.randomUUID();
  }

  const url = path.startsWith("http")
    ? path
    : `${cortexUrl()}${path.startsWith("/") ? "" : "/"}${path}`;
  const response = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const json = (await response.json().catch(() => null)) as
    | CortexSuccess<T>
    | CortexErrorBody
    | null;
  if (!json || typeof json !== "object" || !("status" in json)) {
    throw new CortexApiError(
      "internal",
      `invalid response HTTP ${response.status}`,
      "",
      response.status,
    );
  }
  if (json.status === "error") {
    throw new CortexApiError(
      json.error_code || "internal",
      json.message || "request failed",
      json.request_id || "",
      response.status,
    );
  }
  return json.data;
}
