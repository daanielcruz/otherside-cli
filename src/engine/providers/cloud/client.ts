import {
  detectQuotaExhaustion,
  isRetryableNetworkError,
  ProviderHttpError,
  parseRetryAfterHeader,
} from "@/engine/providers/_shared/retry.ts";
import { readResponseBody } from "@/engine/providers/_shared/stream-body.ts";
import { parseSse } from "@/kernel/std/stream/sse.ts";

const API_ORIGIN = "https://api.anthropic.com";
const EVENT_PAGE_SIZE = 200;

export interface CloudCredentials {
  accessToken: string;
  organizationUuid?: string;
  accountUuid?: string;
}

export interface CloudClientOptions {
  currentTokens: () => Promise<CloudCredentials>;
  userAgent: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  maxReconnects?: number;
}

export interface CloudEvent {
  event_id?: string;
  sequence_num?: string;
  source?: string;
  event_type: string;
  payload: Record<string, unknown>;
}

export interface CloudCursor {
  sequence: string;
  eventIds: Set<string>;
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Cloud protocol: expected ${label}`);
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Cloud protocol: missing ${label}`);
  }
  return value;
}

function sequence(value: unknown): string {
  const result = string(value, "sequence_num");
  if (!/^\d+$/.test(result)) throw new Error("Cloud protocol: invalid sequence_num");
  return result;
}

export function parseCloudEvent(value: unknown): CloudEvent {
  const event = record(value, "event");
  return {
    event_type: string(event.event_type, "event_type"),
    payload: record(event.payload, "event payload"),
    ...(event.source !== undefined ? { source: string(event.source, "event source") } : {}),
    ...(event.event_id !== undefined ? { event_id: string(event.event_id, "event_id") } : {}),
    ...(event.sequence_num !== undefined ? { sequence_num: sequence(event.sequence_num) } : {}),
  };
}

export class CloudIdentityChangedError extends Error {
  constructor() {
    super("Cloud account/organization identity changed; the previous session cannot be resumed");
    this.name = "CloudIdentityChangedError";
  }
}

export class CloudClient {
  constructor(private readonly options: CloudClientOptions) {
    if (!options.userAgent.trim()) throw new Error("Cloud client requires the CLI User-Agent");
  }

  async assertCurrentIdentity(): Promise<void> {
    await this.options.currentTokens();
  }

  async bindCurrentIdentity(): Promise<CloudClient> {
    const identity = credentialIdentity(await this.options.currentTokens());
    const currentTokens = async (): Promise<CloudCredentials> => {
      const tokens = await this.options.currentTokens();
      if (credentialIdentity(tokens) !== identity) throw new CloudIdentityChangedError();
      return tokens;
    };
    return new CloudClient({ ...this.options, currentTokens });
  }

  async resolveEnvironment(preferredId: string | undefined, signal: AbortSignal): Promise<string> {
    const response = await this.request("/v1/environment_providers", { method: "GET", signal });
    const page = record(await response.json(), "environment providers page");
    if (!Array.isArray(page.environments) || typeof page.has_more !== "boolean") {
      throw new Error("Cloud environment providers response is invalid");
    }
    const activeIds: string[] = [];
    for (const value of page.environments) {
      const environment = record(value, "environment provider");
      if (environment.kind !== "anthropic_cloud" || environment.state !== "active") continue;
      activeIds.push(string(environment.environment_id, "environment_id"));
    }
    const preferred = preferredId?.trim();
    if (preferred && activeIds.includes(preferred)) return preferred;
    if (page.has_more) {
      throw new Error(
        "Cloud returned a partial environment list; no unambiguous active environment was selected",
      );
    }
    if (preferred)
      throw new Error(
        "The configured Cloud environment is not an active anthropic_cloud environment",
      );
    // Adapter policy, not a claim about Cloud's ordering or a service-side default.
    const selected = activeIds[0];
    if (!selected) throw new Error("No active anthropic_cloud environment is available");
    return selected;
  }

  async createSession(input: {
    title: string;
    environmentId: string;
    model: string;
    effort: string;
    signal: AbortSignal;
  }): Promise<string> {
    const response = await this.request("/v1/code/sessions", {
      method: "POST",
      signal: input.signal,
      body: JSON.stringify({
        title: input.title,
        environment_id: input.environmentId,
        config: {
          sources: [],
          outcomes: [],
          model: input.model,
          effort_level: input.effort,
        },
        events: [],
      }),
    });
    const body = record(await response.json(), "session response");
    const session = record(body.session, "session");
    const id = string(session.id, "session.id");
    if (!id.startsWith("cse_")) throw new Error("Cloud protocol: invalid session.id");
    return id;
  }

  async archiveSession(sessionId: string, signal: AbortSignal): Promise<void> {
    const response = await this.request(`${sessionPath(sessionId)}/archive`, {
      method: "POST",
      body: JSON.stringify({}),
      signal,
    });
    await response.arrayBuffer();
  }

  async postEvent(
    sessionId: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.request(`${sessionPath(sessionId)}/events`, {
      method: "POST",
      body: JSON.stringify({ events: [{ payload }] }),
      signal,
    });
    const receipt = record(await response.json(), "event receipt");
    if (!Array.isArray(receipt.results) || receipt.results.length !== 1) {
      throw new Error("Cloud protocol: missing event receipt results");
    }
    const result = record(receipt.results[0], "event receipt result");
    string(result.event_id, "receipt event_id");
    // This receipt only confirms delivery. SDK control responses arrive on the event stream.
  }

  async *events(
    sessionId: string,
    cursor: CloudCursor,
    signal: AbortSignal,
    lifecycle?: { onOpen?: () => void; onReconnect: () => void },
  ): AsyncGenerator<CloudEvent | null> {
    let reconnects = 0;
    while (true) {
      signal.throwIfAborted();
      yield* this.catchUp(sessionId, cursor, signal);
      try {
        const response = await this.request(
          `${sessionPath(sessionId)}/events/stream?from_sequence_num=${encodeURIComponent(cursor.sequence)}`,
          { method: "GET", signal, headers: { Accept: "text/event-stream" } },
        );
        if (!response.body) throw new Error("Cloud event stream has no body");
        // Readiness is the successful SSE response, not a durable catch-up page or first event.
        lifecycle?.onOpen?.();
        for await (const event of parseSse(readResponseBody(response.body))) {
          signal.throwIfAborted();
          if (event.isComment && !event.data) {
            yield null;
            continue;
          }
          if (event.event !== "client_event" && event.event !== "ephemeral_event") continue;
          const parsed = parseCloudEvent(JSON.parse(event.data));
          if (event.event === "client_event" && !parsed.sequence_num) {
            throw new Error("Cloud durable event is missing sequence_num");
          }
          if (acceptEvent(parsed, cursor)) {
            reconnects = 0;
            yield parsed;
          }
        }
      } catch (error) {
        signal.throwIfAborted();
        if (!isRetryableNetworkError(error)) throw error;
      }
      // Stateful callers must decide whether worker protection survived before any replay.
      lifecycle?.onReconnect();
      if (++reconnects > (this.options.maxReconnects ?? 3)) {
        throw new Error("Cloud event stream disconnected repeatedly; session was not resubmitted");
      }
    }
  }

  private async *catchUp(
    sessionId: string,
    cursor: CloudCursor,
    signal: AbortSignal,
  ): AsyncGenerator<CloudEvent> {
    while (true) {
      const before = cursor.sequence;
      const response = await this.request(
        `${sessionPath(sessionId)}/events?limit=${EVENT_PAGE_SIZE}&sort_order=asc&cursor=${encodeURIComponent(before)}`,
        { method: "GET", signal },
      );
      const page = record(await response.json(), "events page");
      if (!Array.isArray(page.data)) throw new Error("Cloud protocol: missing events page data");
      for (const value of page.data) {
        const event = parseCloudEvent(value);
        if (!event.sequence_num || !event.event_id) {
          throw new Error("Cloud durable event is missing event_id or sequence_num");
        }
        if (acceptEvent(event, cursor)) yield event;
      }
      const resume = sequence(page.resume_cursor);
      if (BigInt(resume) > BigInt(cursor.sequence)) cursor.sequence = resume;
      if (page.data.length < EVENT_PAGE_SIZE || cursor.sequence === before) return;
    }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const tokens = await this.options.currentTokens();
    if (!tokens.accessToken || !tokens.organizationUuid) {
      throw new Error("Cloud credentials require accessToken and organizationUuid; log in again");
    }
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${tokens.accessToken}`);
    headers.set("anthropic-version", "2023-06-01");
    headers.set("anthropic-client-platform", "claude_code_cli");
    headers.set("x-organization-uuid", tokens.organizationUuid);
    headers.set("User-Agent", this.options.userAgent);
    if (init.body) headers.set("Content-Type", "application/json");
    const response = await (this.options.fetch ?? fetch)(`${API_ORIGIN}${path}`, {
      ...init,
      headers,
      redirect: "error",
    });
    if (response.ok) return response;
    const body = (await response.text()).replaceAll(tokens.accessToken, "[redacted]");
    const retryAfterHeader = response.headers.get("retry-after");
    const quota = detectQuotaExhaustion({
      provider: "anthropic-cloud",
      status: response.status,
      headers: response.headers,
      body,
      retryAfterMs: parseRetryAfterHeader(retryAfterHeader),
    });
    throw new ProviderHttpError({
      provider: "anthropic-cloud",
      status: response.status,
      body,
      retryAfterHeader,
      shouldRetryHeader: response.headers.get("x-should-retry"),
      quotaExhausted: quota.quotaExhausted,
      quotaResetEpochMs: quota.resetEpochMs,
    });
  }
}

function credentialIdentity(tokens: CloudCredentials): string {
  return JSON.stringify([
    string(tokens.organizationUuid, "credential organizationUuid"),
    string(tokens.accountUuid, "credential accountUuid"),
  ]);
}

function sessionPath(sessionId: string): string {
  return `/v1/code/sessions/${encodeURIComponent(sessionId)}`;
}

function acceptEvent(event: CloudEvent, cursor: CloudCursor): boolean {
  if (event.event_id && cursor.eventIds.has(event.event_id)) return false;
  if (event.sequence_num && BigInt(event.sequence_num) <= BigInt(cursor.sequence)) return false;
  if (event.event_id) cursor.eventIds.add(event.event_id);
  if (event.sequence_num) cursor.sequence = event.sequence_num;
  return true;
}

const encoder = new TextEncoder();

export function encodeCloudEvent(event: CloudEvent | null): Uint8Array {
  if (!event) return encoder.encode(":keepalive\n\n");
  const name = event.sequence_num ? "client_event" : "ephemeral_event";
  return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(event)}\n\n`);
}
