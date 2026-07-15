import { CortexApiError, cortexFetch } from "@/remote/_infra/cortex.ts";
import type { SessionWrap } from "@/remote/crypto/e2ee.ts";
import { forceRefreshAuth, loadFreshAuth } from "./auth.ts";

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

async function callCortex<T>(path: string, body: unknown, forceRefresh = false): Promise<T> {
  const auth = forceRefresh ? await forceRefreshAuth() : await loadFreshAuth();
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
      if (err.code === "unauthorized" && !forceRefresh) {
        return callCortex<T>(path, body, true);
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
  sender_device_id: string;
  type: string;
  payload: Record<string, unknown>;
  counter: number;
  ts: string;
}

/** Newest-first page of durable session events (cortex keyset order). */
export async function listSessionEvents(sessionId: string, limit = 50): Promise<SessionEventRow[]> {
  const auth = await loadFreshAuth();
  if (!auth) {
    throw new RemoteApiError("unauthorized", "CLI is not paired — run /remote pair", "");
  }
  try {
    return await cortexFetch<SessionEventRow[]>(`/v1/sessions/${sessionId}/events?limit=${limit}`, {
      method: "GET",
      token: auth.accessToken,
      client: "cli",
      signal: AbortSignal.timeout(SESSION_EVENTS_TIMEOUT_MS),
    });
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
  return `${input.kind ?? "cli"}|${input.fingerprint_hash}|${input.device_label}`;
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

export interface MintDesignOpenTokenInput {
  session_id: string;
  cli_environment_id: string;
}

export interface MintDesignOpenTokenResult {
  token: string;
  expires_at: string;
  session_id: string;
}

export function mintDesignOpenToken(
  input: MintDesignOpenTokenInput,
): Promise<MintDesignOpenTokenResult> {
  return callCortex<MintDesignOpenTokenResult>("/v1/design/open-tokens", input);
}

export interface ConfirmPairingInput {
  cli_device_id: string;
  app_device_id: string;
  pair_session_id: string;
  app_pub: string;
  confirm_token: string;
  cli_device_label?: string;
  cli_fingerprint?: string;
}

export interface ConfirmPairingResult {
  cli_device_id?: string;
  app_device_id?: string;
  pairing?: { device_a: string; device_b: string };
  created?: boolean;
  verified_at?: string;
}

export function confirmPairing(input: ConfirmPairingInput): Promise<ConfirmPairingResult> {
  return callCortex<ConfirmPairingResult>("/v1/pairings/confirm", input);
}

export interface UnpairInput {
  cli_device_id: string;
  app_device_id?: string;
}

export interface UnpairResult {
  removed?: boolean;
  revoked?: boolean;
}

export function unpair(input: UnpairInput): Promise<UnpairResult> {
  return callCortex<UnpairResult>("/v1/pairings/unpair", input);
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
