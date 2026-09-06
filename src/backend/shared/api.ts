import { currentUserId, forceRefreshAuth, loadFreshAuth } from "./auth.ts";
import { CortexApiError, cortexFetch } from "./cortex.ts";
import type { SessionWrap } from "./e2ee.ts";

export class RemoteApiError extends Error {
  readonly code: string;
  readonly requestId: string;
  constructor(code: string, message: string, requestId: string) {
    super(message);
    this.name = "RemoteApiError";
    this.code = code;
    this.requestId = requestId;
  }
}

export async function callCortex<T>(
  path: string,
  body: unknown,
  rejectedAccessToken?: string,
): Promise<T> {
  const auth = rejectedAccessToken
    ? await forceRefreshAuth(rejectedAccessToken)
    : await loadFreshAuth();
  if (!auth) {
    throw new RemoteApiError("unauthorized", "CLI is not paired — run /remote pair", "");
  }
  try {
    return await cortexFetch<T>(path, {
      method: "POST",
      token: auth.accessToken,
      body,
      idempotencyKey: crypto.randomUUID(),
      client: "cli",
    });
  } catch (err) {
    if (err instanceof CortexApiError) {
      if (err.code === "unauthorized" && !rejectedAccessToken) {
        return callCortex<T>(path, body, auth.accessToken);
      }
      throw new RemoteApiError(err.code, err.message, err.requestId);
    }
    throw err;
  }
}

export const SESSION_EVENTS_TIMEOUT_MS = 10_000;

export interface SessionEventRow {
  id: string;
  session_id: string;
  instance_id: string;
  sender_device_id: string;
  type: string;
  payload: Record<string, unknown>;
  counter: number;
  ts: string;
}

export interface SessionEventCursor {
  ts: string;
  id: string;
}

export interface SessionEventPageOptions {
  limit?: number;
  after?: SessionEventCursor;
}

export async function listSessionEvents(
  sessionId: string,
  options: SessionEventPageOptions = {},
): Promise<SessionEventRow[]> {
  const auth = await loadFreshAuth();
  if (!auth) {
    throw new RemoteApiError("unauthorized", "CLI is not paired — run /remote pair", "");
  }
  const query = new URLSearchParams();
  query.set("limit", String(options.limit ?? 50));
  if (options.after) {
    query.set("after_ts", options.after.ts);
    query.set("after_id", options.after.id);
  }
  try {
    return await cortexFetch<SessionEventRow[]>(
      `/v1/sessions/${sessionId}/events?${query.toString()}`,
      {
        method: "GET",
        token: auth.accessToken,
        client: "cli",
        signal: AbortSignal.timeout(SESSION_EVENTS_TIMEOUT_MS),
      },
    );
  } catch (err) {
    if (err instanceof CortexApiError) {
      throw new RemoteApiError(err.code, err.message, err.requestId);
    }
    throw err;
  }
}

export interface RegisterEnvironmentInput {
  id?: string;
  device_label: string;
  fingerprint_hash: string;
  kind?: "cli" | "app";
}

export interface RegisterEnvironmentResult {
  environment_id: string;
  created: boolean;
}

const REGISTER_ENVIRONMENT_DEDUPE_MS = 5 * 60 * 1000;

interface RegisterDedupeEntry {
  expiresAt: number;
  promise: Promise<RegisterEnvironmentResult>;
}

const registerEnvironmentDedupeCache = new Map<string, RegisterDedupeEntry>();

function registerDedupeKey(input: RegisterEnvironmentInput): string {
  return `${currentUserId() ?? ""}|${input.id ?? ""}|${input.kind ?? "cli"}|${input.fingerprint_hash}|${input.device_label}`;
}

export function registerEnvironment(
  input: RegisterEnvironmentInput,
): Promise<RegisterEnvironmentResult> {
  const key = registerDedupeKey(input);
  const now = Date.now();
  const cached = registerEnvironmentDedupeCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }
  const promise = callCortex<{ id?: string; environment_id?: string; created?: boolean }>(
    "/v1/environments",
    {
      id: input.id,
      device_label: input.device_label,
      fingerprint_hash: input.fingerprint_hash,
      kind: input.kind ?? "cli",
    },
  )
    .then((data) => ({
      environment_id: data.environment_id ?? data.id ?? input.id ?? "",
      created: data.created ?? true,
    }))
    .catch((err) => {
      registerEnvironmentDedupeCache.delete(key);
      throw err;
    });
  registerEnvironmentDedupeCache.set(key, {
    expiresAt: now + REGISTER_ENVIRONMENT_DEDUPE_MS,
    promise,
  });
  return promise;
}

export function _resetRegisterEnvironmentDedupeForTests(): void {
  registerEnvironmentDedupeCache.clear();
}

export interface SessionKeyEntry {
  device_id: string;
  sender_device_id: string;
  wrapped: SessionWrap;
}

export interface ShareSessionKeyInput {
  session_id: string;
  entries: SessionKeyEntry[];
}

export interface ShareSessionKeyResult {
  session_id?: string;
  inserted?: number;
  ok?: boolean;
  count?: number;
}

export function shareSessionKey(input: ShareSessionKeyInput): Promise<ShareSessionKeyResult> {
  return callCortex<ShareSessionKeyResult>(`/v1/sessions/${input.session_id}/keys`, {
    keys: input.entries,
  });
}
