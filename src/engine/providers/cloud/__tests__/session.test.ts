import { describe, expect, it, spyOn } from "bun:test";
import { classifyProviderError } from "@/engine/transport/_infra/classify/classify.ts";
import { classifyError } from "@/engine/transport/_infra/classify/error-classifier.ts";
import { streamWithRetry } from "@/engine/transport/_infra/classify/retry.ts";
import { ProviderHttpError } from "@/kernel/std/types/error-meta.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { type CloudEvent, encodeCloudEvent, record } from "../client.ts";
import { buildCloudHistorySnapshot } from "../history.ts";
import {
  CLOUD_BOUNDARY_HOOK_ID,
  CLOUD_CONNECT_TOOL,
  CLOUD_CONNECT_TOOL_NAME,
  CLOUD_LOCAL_TOOL_TIMEOUT_MS,
  MCP_TOOL_PREFIX,
  mcpHandshake,
} from "../mcp.ts";
import {
  type CloudAdapterOptions,
  CloudCallbackContentionError,
  CloudLocalCallAbandonedError,
  CloudSessionInterruptedError,
  cloudSessionKey,
  createAnthropicCloudAdapter,
} from "../session.ts";

const TOOL = {
  name: "Calculate",
  description: "Local arithmetic",
  input_schema: { type: "object", properties: { expression: { type: "string" } } },
};
const CONTEXT: RequestContext = {
  provider: "anthropic-cloud",
  model: "claude-opus-5-5",
  effort: "medium",
  sessionId: "local-session",
  cwd: ".",
  permissionMode: "default",
};
const USER: Message = { role: "user", content: [{ type: "text", text: "17+25" }] };
const ASSISTANT: Message = { role: "assistant", content: [{ type: "text", text: "42" }] };
const RESULT: Message = {
  role: "tool",
  content: [{ type: "tool_result", tool_use_id: "tool-use-42", content: "42" }],
};
const SYNTHETIC_REFUSAL_TEXT =
  "API Error: Opus 5.5 safeguards flagged this message. Details: [reasoning_extraction].";
function syntheticAssistantError() {
  return {
    type: "assistant",
    error: "invalid_request",
    is_api_error_message: true,
    message: {
      id: "synthetic-error",
      model: "<synthetic>",
      stop_reason: "refusal",
      content: [{ type: "text", text: SYNTHETIC_REFUSAL_TEXT }],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
}

const NATIVE_TOOLS = ["Bash", "Read", "Task", "ToolSearch"];
const EDE_DIAGNOSTIC =
  "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use";
const AUTO_BACKGROUND_NOTICE =
  'MCP tool "otherside/Calculate" is still running after 120s. It was moved to the background as task mcp-test and keeps running; you\'ll receive a notification with the result when it completes. You can keep working in the meantime. To stop it, use TaskStop with task_id "mcp-test". Note: it does not survive exiting this session.';

interface MockSession {
  events: CloudEvent[];
  users: number;
  effort: string;
  model: string;
  flagSettings: Record<string, unknown>;
}

class CloudFixture {
  tokens = {
    accessToken: "mock-access",
    organizationUuid: "mock-org",
    accountUuid: "mock-account",
  };
  posts: Record<string, unknown>[] = [];
  requests: { url: URL; init: RequestInit }[] = [];
  creates: Record<string, unknown>[] = [];
  archives: string[] = [];
  archiveStatus = 200;
  beforeArchive?: (init: RequestInit) => Promise<void> | void;
  failInterrupt = false;
  interruptEvents?: (payload: Record<string, unknown>) => void;
  settingsReply?: Record<string, unknown>;
  onApplySettings?: () => void;
  sessionPrefix = "cse_mock";
  sessions = new Map<string, MockSession>();
  current: MockSession = {
    events: [],
    users: 0,
    effort: "medium",
    model: "claude-opus-5-5",
    flagSettings: {},
  };
  live = new Set<ReadableStreamDefaultController<Uint8Array>>();
  lifecycle: string[] = [];
  rules: Record<string, unknown>[] = [];
  pid: number | undefined = 41;
  hooksApplied = true;
  managedOnly = false;
  includeInventory = true;
  missingBootstrapCallback = false;
  bootstrapNativeAttempt = false;
  bootstrapNativeResult: boolean | undefined = true;
  bootstrapError?: string;
  failControl?: string;
  silentControl?: string;
  silentControlSession?: MockSession;
  permissionListings = 0;
  changedLists = 0;
  onToolListChanged: () => void = () =>
    this.rpc("tools/list", {}, `updated-${this.changedLists}`, `updated-list-${this.changedLists}`);
  holdControlReceipts = false;
  unreadControlReceipts = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  ephemeralControlsDelivered = 0;
  ephemeralControlsDropped = 0;
  beforeStream?: () => Promise<void>;
  streamStatus = 200;
  historyStatus = 200;
  filterRules: (rules: Record<string, unknown>[]) => Record<string, unknown>[] = (rules) => rules;
  onUser: (payload: Record<string, unknown>) => void = () => this.finish();
  onToolResult: () => void = () => this.finish();
  beforeResponse?: (payload: Record<string, unknown>, init: RequestInit) => Promise<void> | void;
  beforeEcho?: (payload: Record<string, unknown>) => void;
  responsePosted?: (payload: Record<string, unknown>) => void;
  streamClosed?: () => void;
  responseWaiters = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();

  waitForResponse(requestId: string): Promise<void> {
    const waiter = Promise.withResolvers<void>();
    this.responseWaiters.set(requestId, waiter);
    return waiter.promise;
  }

  foreignReply(requestId: string, source: "worker" | "client" = "client") {
    this.emit(
      {
        type: "control_response",
        uuid: `foreign-${requestId}`,
        response: {
          subtype: "error",
          request_id: requestId,
          error: "SDK MCP server not found: otherside",
        },
      },
      source,
    );
  }

  adapter(overrides: Partial<CloudAdapterOptions> = {}) {
    return createAnthropicCloudAdapter({
      currentTokens: async () => this.tokens,
      userAgent: "claude-code/test",
      fetch: this.fetch,
      ...overrides,
    });
  }

  fetch = async (address: string, init: RequestInit): Promise<Response> => {
    const url = new URL(address);
    this.requests.push({ url, init });
    expect(url.origin).toBe("https://api.anthropic.com");
    init.signal?.throwIfAborted();
    if (url.pathname === "/v1/environment_providers") {
      return Response.json({
        environments: [
          { kind: "anthropic_cloud", environment_id: "env_mock", name: "Fixture", state: "active" },
        ],
        has_more: false,
        first_id: "env_mock",
        last_id: "env_mock",
      });
    }
    if (url.pathname === "/v1/code/sessions") {
      const body = record(JSON.parse(String(init.body)), "create body");
      this.creates.push(body);
      const config = record(body.config, "session config");
      const id = `${this.sessionPrefix}${this.creates.length}`;
      this.sessions.set(id, {
        events: [],
        users: 0,
        effort: String(config.effort_level),
        model: String(config.model),
        flagSettings: {},
      });
      this.rules = [];
      return Response.json({ session: { id }, deduplicated: false });
    }
    const session = this.sessions.get(url.pathname.split("/")[4] ?? "");
    if (!session) throw new Error("Unknown fixture session");
    this.current = session;
    if (url.pathname.endsWith("/archive")) {
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({});
      this.archives.push(url.pathname.split("/")[4] ?? "");
      this.lifecycle.push("archive");
      await this.beforeArchive?.(init);
      if (this.archiveStatus !== 200)
        return new Response(`Mock archive failed: ${this.tokens.accessToken}`, {
          status: this.archiveStatus,
        });
      return Response.json({});
    }
    if (init.method === "POST") {
      const body = record(JSON.parse(String(init.body)), "post body");
      if (!Array.isArray(body.events)) throw new Error("events missing");
      const payload = record(record(body.events[0], "event").payload, "payload");
      this.posts.push(payload);
      this.beforeEcho?.(payload);
      this.emit(payload, "client");
      let receipt: Promise<void> | undefined;
      if (payload.type === "control_request") {
        const subtype = record(payload.request, "request").subtype;
        if (subtype === "interrupt" && this.failInterrupt)
          return new Response("Mock interrupt failed", { status: 503 });
        if (subtype !== "interrupt" || this.interruptEvents) {
          expect(this.live.size).toBe(1);
          if (this.holdControlReceipts || (subtype === "interrupt" && this.interruptEvents)) {
            const gate = Promise.withResolvers<void>();
            this.unreadControlReceipts.set(String(payload.request_id), gate);
            receipt = gate.promise;
          }
        }
        this.control(payload);
      }
      if (payload.type === "user") {
        expect(this.live.size).toBe(1);
        if (++session.users === 1) this.bootstrap();
        else this.onUser(payload);
      }
      if (payload.type === "control_response") {
        await this.beforeResponse?.(payload, init);
        init.signal?.throwIfAborted();
        this.response(payload);
        this.responsePosted?.(payload);
        const requestId = String(record(payload.response, "response").request_id);
        this.responseWaiters.get(requestId)?.resolve();
        this.responseWaiters.delete(requestId);
      }
      if (receipt) {
        await receipt;
        this.lifecycle.push(`receipt:${String(payload.request_id)}`);
      }
      return Response.json({
        results: [
          {
            event_id: `posted-${this.posts.length}`,
            sequence_num: String(this.posts.length),
            duplicate: false,
          },
        ],
        attestation_feedback: null,
      });
    }
    if (url.pathname.endsWith("/events")) {
      if (this.historyStatus !== 200)
        return new Response("Mock durable history unavailable", { status: this.historyStatus });
      const cursor = BigInt(url.searchParams.get("cursor") ?? "0");
      const data = session.events
        .filter((event) => BigInt(event.sequence_num ?? "0") > cursor)
        .slice(0, Number(url.searchParams.get("limit") ?? 200));
      return Response.json({ data, resume_cursor: data.at(-1)?.sequence_num ?? String(cursor) });
    }
    if (url.pathname.endsWith("/events/stream")) {
      await this.beforeStream?.();
      init.signal?.throwIfAborted();
      if (this.streamStatus !== 200)
        return new Response("Mock SSE unavailable", { status: this.streamStatus });
      const from = BigInt(url.searchParams.get("from_sequence_num") ?? "0");
      const data = session.events.filter((event) => BigInt(event.sequence_num ?? "0") > from);
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const abort = () => {
        if (!this.live.delete(controller)) return;
        this.lifecycle.push("reader-close");
        this.streamClosed?.();
        controller.error(init.signal?.reason);
      };
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (output) => {
            controller = output;
            for (const event of data) this.chunk(output, encodeCloudEvent(event));
            this.live.add(output);
            this.lifecycle.push("sse-open");
            init.signal?.addEventListener("abort", abort, { once: true });
          },
          pull: () => {
            // A new pull after our queued chunks drain proves the client read the ephemeral frame
            // while POST is still waiting for its receipt; socket readiness alone is insufficient.
            for (const [id, receipt] of this.unreadControlReceipts) {
              this.lifecycle.push(`control-read:${id}`);
              receipt.resolve();
            }
            this.unreadControlReceipts.clear();
          },
          cancel: () => {
            this.live.delete(controller);
            this.lifecycle.push("reader-close");
            this.streamClosed?.();
            init.signal?.removeEventListener("abort", abort);
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    throw new Error(`Unexpected mock request: ${url.pathname}`);
  };

  chunk(output: ReadableStreamDefaultController<Uint8Array>, bytes: Uint8Array) {
    for (let offset = 0; offset < bytes.length; offset += 13)
      output.enqueue(bytes.slice(offset, offset + 13));
  }

  emit(payload: Record<string, unknown>, source: "worker" | "client" = "worker") {
    const event: CloudEvent = { event_type: "message", payload, source };
    if (payload.type === "control_response" && source === "worker") {
      if (this.live.size === 0) this.ephemeralControlsDropped++;
      else this.ephemeralControlsDelivered++;
    } else {
      event.event_id = `event-${this.current.events.length + 1}`;
      event.sequence_num = String(this.current.events.length + 1);
      this.current.events.push(event);
    }
    for (const output of this.live) this.chunk(output, encodeCloudEvent(event));
  }

  control(payload: Record<string, unknown>) {
    const request = record(payload.request, "request");
    if (request.subtype === "interrupt") {
      this.lifecycle.push("interrupt");
      this.interruptEvents?.(payload);
      return;
    }
    if (
      request.subtype === this.silentControl &&
      (!this.silentControlSession || this.current === this.silentControlSession)
    )
      return;
    if (request.subtype === this.failControl) {
      this.emit({
        type: "control_response",
        response: { subtype: "error", request_id: payload.request_id, error: "Control rejected" },
      });
      return;
    }
    let response: Record<string, unknown> | undefined;
    if (request.subtype === "initialize") {
      response = { pid: this.pid, ...(request.hooks ? { hooks_applied: this.hooksApplied } : {}) };
    }
    if (request.subtype === "mcp_set_servers") {
      this.rpc("initialize", { protocolVersion: "2025-03-26" }, 1, "init-control");
      this.rpc("notifications/initialized", {}, undefined, "initialized-control");
      this.rpc("tools/list", {}, "bootstrap-list", "bootstrap-list-control");
      response = { added: ["otherside"], removed: [], errors: {} };
    }
    if (request.subtype === "list_permission_rules") {
      this.permissionListings++;
      response = { state: { rules: this.filterRules(this.rules), managedOnly: this.managedOnly } };
    }
    if (request.subtype === "apply_flag_settings") {
      const settings = record(request.settings, "settings");
      this.current.flagSettings = { ...this.current.flagSettings, ...settings };
      if (settings.effortLevel !== undefined) this.current.effort = String(settings.effortLevel);
      this.onApplySettings?.();
    }
    if (request.subtype === "get_settings") {
      response = this.settingsReply ?? {
        effective: this.current.flagSettings,
        sources: [{ source: "flagSettings", settings: this.current.flagSettings }],
        applied: { effort: this.current.effort, model: this.current.model },
      };
    }
    if (request.subtype === "mcp_message") {
      const message = record(request.message, "MCP message");
      if (message.method === "notifications/tools/list_changed") {
        this.changedLists++;
        // Delivery acknowledgement does not mean the worker refreshed its catalog.
        this.emit({
          type: "control_response",
          response: { subtype: "success", request_id: payload.request_id },
        });
        this.onToolListChanged();
        return;
      }
    }
    this.emit({
      type: "control_response",
      response: { subtype: "success", request_id: payload.request_id, response },
    });
  }

  response(payload: Record<string, unknown>) {
    const control = record(payload.response, "control response");
    const response = record(control.response, "control result");
    if (
      response.hookSpecificOutput &&
      record(response.hookSpecificOutput, "hook output").permissionDecision === "deny"
    ) {
      this.lifecycle.push("hook-deny");
      if (control.request_id === "bootstrap-native-hook") {
        if (this.bootstrapNativeResult !== undefined)
          this.emit({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "native-bootstrap-use",
                  is_error: this.bootstrapNativeResult,
                  content: "Denied by local hook",
                },
              ],
            },
          });
        this.connect();
      }
      return;
    }
    if (control.request_id === "bootstrap-hook") {
      expect(response).toMatchObject({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" },
      });
      this.emit({
        type: "control_request",
        request_id: "bootstrap-permission",
        request: {
          subtype: "can_use_tool",
          tool_name: `${MCP_TOOL_PREFIX}${CLOUD_CONNECT_TOOL_NAME}`,
          tool_use_id: "bootstrap-use",
          input: {},
        },
      });
    }
    if (control.request_id === "bootstrap-permission" && response.behavior === "allow") {
      if (!Array.isArray(response.updatedPermissions))
        throw new Error("Bootstrap did not send session deny rules");
      const update = record(response.updatedPermissions[0], "permission update");
      expect(update).toMatchObject({ type: "addRules", destination: "session", behavior: "deny" });
      if (!Array.isArray(update.rules)) throw new Error("deny rules missing");
      this.rules = update.rules.map((value) => {
        const rule = record(value, "rule");
        return {
          source: "session",
          behavior: "deny",
          rule: rule.toolName === "Task" ? "Agent" : rule.toolName,
        };
      });
      this.rpc(
        "tools/call",
        {
          name: CLOUD_CONNECT_TOOL_NAME,
          arguments: {},
          _meta: { "claudecode/toolUseId": "bootstrap-use", progressToken: "bootstrap-progress" },
        },
        "bootstrap-rpc",
        "bootstrap-call",
      );
    }
    if (control.request_id === "bootstrap-call") {
      this.assistant("bootstrap-answer", [{ type: "text", text: "CONNECTED INTERNALLY" }], {
        input_tokens: 3,
        output_tokens: 2,
      });
      this.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "CONNECTED INTERNALLY",
        usage: { input_tokens: 7, output_tokens: 3 },
      });
    }
    if (control.request_id === "call-control") this.onToolResult();
  }

  bootstrap() {
    if (this.bootstrapError) {
      this.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [this.bootstrapError],
      });
      return;
    }
    if (this.includeInventory)
      this.emit({
        type: "system",
        subtype: "init",
        tools: [...NATIVE_TOOLS, `${MCP_TOOL_PREFIX}${CLOUD_CONNECT_TOOL_NAME}`],
      });
    if (this.missingBootstrapCallback) {
      this.emit({ type: "result", subtype: "success", is_error: false, result: "No tool called" });
      return;
    }
    if (this.bootstrapNativeAttempt) {
      this.assistant(
        "bootstrap-native-intent",
        [
          {
            type: "tool_use",
            id: "native-bootstrap-use",
            name: "ToolSearch",
            input: { query: "Connect" },
          },
        ],
        { input_tokens: 2, output_tokens: 1 },
      );
      this.hook("bootstrap-native-hook", "ToolSearch");
      return;
    }
    this.connect();
  }

  connect() {
    this.assistant(
      "bootstrap-intent",
      [
        {
          type: "tool_use",
          id: "bootstrap-use",
          name: `${MCP_TOOL_PREFIX}${CLOUD_CONNECT_TOOL_NAME}`,
          input: {},
        },
      ],
      { input_tokens: 4, output_tokens: 1 },
    );
    this.hook("bootstrap-hook", `${MCP_TOOL_PREFIX}${CLOUD_CONNECT_TOOL_NAME}`);
  }

  hook(requestId: string, name: string) {
    this.emit({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "hook_callback",
        callback_id: CLOUD_BOUNDARY_HOOK_ID,
        input: { hook_event_name: "PreToolUse", tool_name: name, tool_input: {} },
      },
    });
  }

  rpc(
    method: string,
    params: Record<string, unknown>,
    id: string | number | undefined,
    requestId: string,
  ) {
    this.emit({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "mcp_message",
        server_name: "otherside",
        message: { jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, params },
      },
    });
  }

  assistant(id: string, content: unknown[], usage: Record<string, number>) {
    this.emit({ type: "assistant", message: { id, model: "claude-opus-5-5", content, usage } });
  }

  nativeIntent(name: string, id = "native-use") {
    this.assistant(`intent-${id}`, [{ type: "tool_use", id, name, input: {} }], {
      input_tokens: 4,
      output_tokens: 2,
    });
  }

  nativeResult(id: string, isError: boolean | undefined, source: "worker" | "client" = "worker") {
    this.emit(
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: id,
              ...(isError !== undefined ? { is_error: isError } : {}),
              content: "Native permission result",
            },
          ],
        },
      },
      source,
    );
  }

  backgroundCall(content: unknown = AUTO_BACKGROUND_NOTICE, toolUseId = "tool-use-42") {
    this.emit({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
      },
    });
  }

  cancelCall(rpcId: string | number = "rpc-42") {
    this.rpc(
      "notifications/cancelled",
      { requestId: rpcId, reason: "Local tool result timed out" },
      undefined,
      `cancel-${rpcId}`,
    );
  }

  callTool(name = "Calculate", rpcId: string | number = "rpc-42") {
    this.assistant(
      "msg-tool",
      [
        {
          type: "tool_use",
          id: "tool-use-42",
          name: `${MCP_TOOL_PREFIX}${name}`,
          input: { expression: "17+25" },
        },
      ],
      { input_tokens: 10, output_tokens: 5 },
    );
    this.hook("local-hook", `${MCP_TOOL_PREFIX}${name}`);
    this.emit({
      type: "control_request",
      request_id: "permission-control",
      request: {
        subtype: "can_use_tool",
        tool_name: `${MCP_TOOL_PREFIX}${name}`,
        tool_use_id: "tool-use-42",
        input: { expression: "17+25" },
        permission_suggestions: [{ type: "addRules", behavior: "allow" }],
      },
    });
    this.rpc(
      "tools/call",
      {
        name,
        arguments: { expression: "17+25" },
        _meta: { "claudecode/toolUseId": "tool-use-42", progressToken: "progress-42" },
      },
      rpcId,
      "call-control",
    );
  }

  finish() {
    this.assistant(`answer-${this.posts.length}`, [{ type: "text", text: "42" }], {
      input_tokens: 12,
      output_tokens: 2,
    });
    this.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "42",
      usage: { input_tokens: 22, output_tokens: 7 },
    });
  }

  userPosts() {
    return this.posts.filter(
      (post) => post.type === "user" && Array.isArray(record(post.message, "message").content),
    );
  }
  controls() {
    return this.posts
      .filter((post) => post.type === "control_request")
      .map((post) => record(post.request, "request"));
  }
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

type Adapter = ReturnType<typeof createAnthropicCloudAdapter>;
function run(
  adapter: Adapter,
  messages: Message[] = [USER],
  signal = new AbortController().signal,
  ctx = CONTEXT,
  tools: unknown[] = [TOOL],
) {
  return collect(
    adapter.translateResponse(
      adapter.stream(ctx, adapter.translateRequest(ctx, messages, tools), signal),
    ),
  );
}

function responseFor(fixture: CloudFixture, requestId: string) {
  const payload = fixture.posts.find(
    (post) =>
      post.type === "control_response" &&
      record(post.response, "response").request_id === requestId,
  );
  return record(record(payload?.response, "response").response, "result");
}
function usage(events: ProviderEvent[]) {
  return events.filter((event) => event.kind === "usage").at(-1);
}

function holdResponseEcho(fixture: CloudFixture, requestId: string) {
  const emit = fixture.emit.bind(fixture);
  let echo: Record<string, unknown> | undefined;
  fixture.emit = (payload, source = "worker") => {
    if (
      source === "client" &&
      payload.type === "control_response" &&
      record(payload.response, "response").request_id === requestId
    ) {
      echo = payload;
      return;
    }
    emit(payload, source);
  };
  return {
    posted: fixture.waitForResponse(requestId),
    release() {
      fixture.emit = emit;
      if (echo) emit(echo, "client");
      echo = undefined;
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the tested operation to reject");
}

function expectedSnapshot(
  history: readonly Message[],
  current: Record<string, unknown>[],
): Record<string, unknown>[] {
  return [
    ...buildCloudHistorySnapshot(history, CONTEXT),
    { type: "text", text: "Current request (not historical data):" },
    ...current,
  ];
}

function expectedContinuation(history: readonly Message[]): Record<string, unknown>[] {
  return expectedSnapshot(history, [
    {
      type: "text",
      text: "Continue the latest still-valid request under the current system instructions using the history above. Historical tool calls and results are context, not new calls; do not repeat completed actions.",
    },
  ]);
}

describe("Cloud expired authentication before an attempt", () => {
  for (const phase of ["first request", "idle session", "pending tool"]) {
    it(`preserves ${phase} and surfaces the auth panel without posting or rotating`, async () => {
      const fixture = new CloudFixture();
      const expired = new ProviderHttpError({
        provider: "anthropic-cloud",
        status: 401,
        body: '{"error":"invalid_grant"}',
      });
      let tokensExpired = false;
      const adapter = fixture.adapter({
        currentTokens: async () => {
          if (tokensExpired) throw expired;
          return fixture.tokens;
        },
      });
      const nextUser: Message = {
        role: "user",
        content: [{ type: "text", text: "A new authenticated request" }],
      };
      let messages = [USER];
      if (phase === "idle session") {
        await run(adapter);
        messages = [USER, ASSISTANT, nextUser];
      }
      if (phase === "pending tool") {
        fixture.onUser = () => fixture.callTool();
        await run(adapter);
        messages = [USER, RESULT];
      }
      tokensExpired = true;
      const requests = fixture.requests.length;
      const posts = fixture.posts.length;
      const creates = fixture.creates.length;
      const live = fixture.live.size;
      const body = adapter.translateRequest(CONTEXT, messages, [TOOL]);
      const attempt = () =>
        collect(
          adapter.translateResponse(adapter.stream(CONTEXT, body, new AbortController().signal)),
        );
      expect(await rejection(attempt())).toBe(expired);
      expect(await rejection(attempt())).toBe(expired);
      expect(fixture.posts).toHaveLength(posts);
      expect(fixture.requests).toHaveLength(requests);
      expect(fixture.creates).toHaveLength(creates);
      expect(fixture.archives).toEqual([]);
      expect(fixture.live.size).toBe(live);
      const decision = adapter.recoverableError(expired, CONTEXT);
      expect(decision).toEqual(
        classifyProviderError(expired, {
          provider: CONTEXT.provider,
          model: CONTEXT.model,
          attempt: 1,
        }),
      );
      expect(decision).toMatchObject({ kind: "fail", status: 401 });
      expect(JSON.stringify(decision)).not.toContain("session stopped unexpectedly");
      expect(
        classifyError({
          err: expired,
          decision,
          provider: CONTEXT.provider,
          model: CONTEXT.model,
          attempt: 1,
          source: "stream-retry",
        }),
      ).toMatchObject({
        title: "Authentication expired",
        summary: "Session expired — run `otherside login --provider anthropic-cloud`.",
        actions: [{ id: "cancel", label: "Cancel" }],
      });
      tokensExpired = false;
      fixture.tokens = { ...fixture.tokens, accessToken: "renewed-access" };
      expect((await attempt()).at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.archives).toEqual([]);
      expect(fixture.userPosts().every((post) => post.session_id === "cse_mock1")).toBe(true);
      if (phase === "idle session") {
        expect(record(fixture.userPosts().at(-1)?.message, "incremental message").content).toEqual(
          nextUser.content,
        );
        expect(fixture.userPosts()).toHaveLength(2);
      }
      if (phase === "pending tool") {
        expect(fixture.userPosts()).toHaveLength(1);
        expect(
          fixture.posts.filter(
            (post) =>
              post.type === "control_response" &&
              record(post.response, "response").request_id === "call-control",
          ),
        ).toHaveLength(1);
      }
    });
  }

  it("still blocks a different account after an expired-token attempt", async () => {
    const fixture = new CloudFixture();
    const expired = new ProviderHttpError({
      provider: "anthropic-cloud",
      status: 401,
      body: '{"error":"invalid_grant"}',
    });
    let tokensExpired = false;
    const adapter = fixture.adapter({
      currentTokens: async () => {
        if (tokensExpired) throw expired;
        return fixture.tokens;
      },
    });
    await run(adapter);
    tokensExpired = true;
    const messages = [USER, ASSISTANT, USER];
    expect(await rejection(run(adapter, messages))).toBe(expired);
    tokensExpired = false;
    fixture.tokens = { ...fixture.tokens, accountUuid: "different-account" };
    const requests = fixture.requests.length;
    await expect(run(adapter, messages)).rejects.toThrow("identity changed");
    await expect(run(adapter, messages)).rejects.toThrow("identity changed");
    expect(fixture.requests).toHaveLength(requests);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toEqual([]);
  });

  it("retains audited detachment for a non-authentication credential lookup failure", async () => {
    const fixture = new CloudFixture();
    const unavailable = new Error("Credential service temporarily unavailable");
    let failNextLookup = false;
    const adapter = fixture.adapter({
      currentTokens: async () => {
        if (failNextLookup) {
          failNextLookup = false;
          throw unavailable;
        }
        return fixture.tokens;
      },
    });
    await run(adapter);
    failNextLookup = true;
    const messages = [USER, ASSISTANT, USER];
    const error = await rejection(run(adapter, messages));
    expect(error).toMatchObject({ name: "CloudSessionInterruptedError", cause: unavailable });
    expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
    const requests = fixture.requests.length;
    expect(await rejection(run(adapter, messages))).toBe(error);
    expect(fixture.requests).toHaveLength(requests);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toEqual([]);
  });

  it("does not bypass failure handling for an authentication failure after posting input", async () => {
    const fixture = new CloudFixture();
    const expired = new ProviderHttpError({
      provider: "anthropic-cloud",
      status: 401,
      body: '{"error":"invalid_grant"}',
    });
    fixture.onUser = () => {
      throw expired;
    };
    const adapter = fixture.adapter();
    const error = await rejection(run(adapter));
    expect(error).toBeInstanceOf(CloudSessionInterruptedError);
    expect(fixture.userPosts()).toHaveLength(1);
    expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
    expect(await rejection(run(adapter))).toBe(error);
    expect(fixture.creates).toHaveLength(1);
  });
});

describe("Cloud thinking display", () => {
  for (const showThinkingSummaries of [true, false, undefined]) {
    for (const suppressThinkingSummary of [true, false]) {
      it(`sets bootstrap thinking display for show=${showThinkingSummaries}, suppress=${suppressThinkingSummary} without a budget`, async () => {
        const fixture = new CloudFixture();
        const ctx = {
          ...CONTEXT,
          ...(showThinkingSummaries !== undefined ? { showThinkingSummaries } : {}),
          suppressThinkingSummary,
        };
        const adapter = fixture.adapter();
        const expected =
          showThinkingSummaries !== false && !suppressThinkingSummary ? "summarized" : "omitted";
        expect(adapter.translateRequest(ctx, [USER], [TOOL]).thinkingDisplay).toBe(expected);
        await run(adapter, [USER], undefined, ctx);
        const controls = fixture.controls();
        const display = controls.filter((request) => request.subtype === "set_max_thinking_tokens");
        expect(display).toEqual([
          { subtype: "set_max_thinking_tokens", thinking_display: expected },
        ]);
        expect(controls.indexOf(display[0]!)).toBeGreaterThan(
          controls.findIndex((request) => request.subtype === "get_settings"),
        );
        const displayPost = fixture.posts.findIndex(
          (post) =>
            post.type === "control_request" &&
            record(post.request, "request").subtype === "set_max_thinking_tokens",
        );
        expect(displayPost).toBeLessThan(fixture.posts.findIndex((post) => post.type === "user"));
      });
    }
  }

  it("updates display once per setting change and verifies the boundary before user input", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    await run(adapter);
    let messages = [USER];
    for (const showThinkingSummaries of [false, false, true]) {
      messages = [...messages, ASSISTANT, USER];
      const before = fixture.posts.length;
      await run(adapter, messages, undefined, { ...CONTEXT, showThinkingSummaries });
      const posts = fixture.posts.slice(before);
      const displayIndex = posts.findIndex(
        (post) =>
          post.type === "control_request" &&
          record(post.request, "request").subtype === "set_max_thinking_tokens",
      );
      if (displayIndex < 0) continue;
      const subsequentControls = posts
        .slice(displayIndex + 1)
        .filter((post) => post.type === "control_request")
        .map((post) => record(post.request, "request").subtype);
      expect(subsequentControls).toEqual(["initialize", "list_permission_rules"]);
      expect(posts.at(-1)?.type).toBe("user");
    }
    expect(
      fixture.controls().filter((request) => request.subtype === "set_max_thinking_tokens"),
    ).toEqual([
      { subtype: "set_max_thinking_tokens", thinking_display: "summarized" },
      { subtype: "set_max_thinking_tokens", thinking_display: "omitted" },
      { subtype: "set_max_thinking_tokens", thinking_display: "summarized" },
    ]);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.userPosts()).toHaveLength(4);
  });

  it("sets the selected display during replacement bootstrap", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    await run(adapter);
    adapter.onCompactionSucceeded(CONTEXT);
    await run(adapter, [USER, ASSISTANT, USER], undefined, {
      ...CONTEXT,
      showThinkingSummaries: false,
    });
    expect(
      fixture.controls().filter((request) => request.subtype === "set_max_thinking_tokens"),
    ).toEqual([
      { subtype: "set_max_thinking_tokens", thinking_display: "summarized" },
      { subtype: "set_max_thinking_tokens", thinking_display: "omitted" },
    ]);
    expect(fixture.creates).toHaveLength(2);
  });

  for (const phase of ["bootstrap", "update"]) {
    for (const failure of ["rejected", "timeout"]) {
      it(`does not send user input when the ${phase} display control is ${failure}`, async () => {
        const fixture = new CloudFixture();
        const adapter = fixture.adapter({ controlTimeoutMs: 20 });
        if (phase === "update") await run(adapter);
        if (failure === "rejected") fixture.failControl = "set_max_thinking_tokens";
        else fixture.silentControl = "set_max_thinking_tokens";
        const error = await rejection(
          run(adapter, phase === "update" ? [USER, ASSISTANT, USER] : [USER], undefined, {
            ...CONTEXT,
            showThinkingSummaries: false,
          }),
        );
        expect(String(error)).toContain("Cloud set_max_thinking_tokens");
        expect(adapter.recoverableError(error, CONTEXT).kind).toBe("fail");
        expect(fixture.posts.filter((post) => post.type === "user")).toHaveLength(
          phase === "update" ? 2 : 0,
        );
        expect(fixture.creates).toHaveLength(1);
        expect(fixture.live.size).toBe(0);
      });
    }
  }

  it("emits nonempty thinking summaries and retains signatures without empty thinking deltas", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => {
      fixture.assistant(
        "thinking",
        [
          { type: "thinking", thinking: "", signature: "empty-text-signature" },
          { type: "thinking", thinking: "Brief reasoning summary", signature: "summary-signature" },
        ],
        {},
      );
      fixture.emit({ type: "result", subtype: "success", is_error: false });
    };
    const events = await run(fixture.adapter());
    expect(
      events.filter(
        (event) => event.kind === "thinking_delta" || event.kind === "thinking_signature",
      ),
    ).toEqual([
      { kind: "thinking_signature", signature: "empty-text-signature" },
      { kind: "thinking_delta", text: "Brief reasoning summary" },
      { kind: "thinking_signature", signature: "summary-signature" },
    ]);
  });
});

describe("Cloud assistant text boundaries", () => {
  it("separates text from distinct assistant IDs in the same stream", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => {
      fixture.assistant("first", [{ type: "text", text: "A" }], {
        input_tokens: 10,
        output_tokens: 1,
      });
      fixture.assistant("second", [{ type: "text", text: "B" }], {
        input_tokens: 20,
        output_tokens: 2,
      });
      fixture.emit({ type: "result", subtype: "success", is_error: false });
    };
    const events = await run(fixture.adapter());
    expect(events.filter((event) => event.kind === "text_delta")).toEqual([
      { kind: "text_delta", text: "A" },
      { kind: "text_delta", text: "\n\n" },
      { kind: "text_delta", text: "B" },
    ]);
    expect(events.filter((event) => event.kind === "message_start")).toHaveLength(1);
    expect(usage(events)).toMatchObject({ contextTokens: 22 });
    expect(events.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
  });

  it("deduplicates repeated blocks without separating text from the same assistant ID", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => {
      fixture.assistant("same", [{ type: "text", text: "A" }], {});
      fixture.assistant(
        "same",
        [
          { type: "text", text: "A" },
          { type: "text", text: "B" },
        ],
        {},
      );
      fixture.assistant(
        "same",
        [
          { type: "text", text: "A" },
          { type: "text", text: "B" },
        ],
        {},
      );
      fixture.emit({ type: "result", subtype: "success", is_error: false });
    };
    const events = await run(fixture.adapter());
    expect(events.filter((event) => event.kind === "text_delta")).toEqual([
      { kind: "text_delta", text: "A" },
      { kind: "text_delta", text: "B" },
    ]);
  });

  it("does not create text boundaries for thinking-only messages or replayed older blocks", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => {
      fixture.assistant("thinking-before", [{ type: "thinking", thinking: "Before text" }], {});
      fixture.assistant("first", [{ type: "text", text: "A" }], {});
      fixture.assistant("thinking-between", [{ type: "thinking", thinking: "Between text" }], {});
      fixture.assistant(
        "first",
        [
          { type: "text", text: "A" },
          { type: "text", text: "B" },
        ],
        {},
      );
      fixture.assistant("second", [{ type: "text", text: "C" }], {});
      fixture.assistant("first", [{ type: "text", text: "A" }], {});
      fixture.assistant(
        "second",
        [
          { type: "text", text: "C" },
          { type: "text", text: "D" },
        ],
        {},
      );
      fixture.emit({ type: "result", subtype: "success", is_error: false });
    };
    const events = await run(fixture.adapter());
    expect(
      events.filter((event) => event.kind === "text_delta" || event.kind === "thinking_delta"),
    ).toEqual([
      { kind: "thinking_delta", text: "Before text" },
      { kind: "text_delta", text: "A" },
      { kind: "thinking_delta", text: "Between text" },
      { kind: "text_delta", text: "B" },
      { kind: "text_delta", text: "\n\n" },
      { kind: "text_delta", text: "C" },
      { kind: "text_delta", text: "D" },
    ]);
  });
});

describe("Cloud synthetic errors and model identity", () => {
  for (const agentic of [true, false]) {
    for (const phase of ["bootstrap", "ready"]) {
      it(`does not rethrow a delivered ${phase} refusal after interrupt HTTP 503 (agentic=${agentic})`, async () => {
        const fixture = new CloudFixture();
        fixture.failInterrupt = true;
        const refuse = () => {
          fixture.emit(syntheticAssistantError());
          fixture.emit({
            type: "result",
            subtype: "success",
            is_error: true,
            result: SYNTHETIC_REFUSAL_TEXT,
          });
          fixture.callTool();
        };
        if (phase === "bootstrap") fixture.bootstrap = refuse;
        else fixture.onUser = refuse;
        const ctx = { ...CONTEXT, agentic };
        const adapter = fixture.adapter();
        const decision = spyOn(adapter, "recoverableError");
        let attempts = 0;
        const events = await collect(
          streamWithRetry(
            ctx,
            {
              startStreamAttempt(context, body) {
                attempts += 1;
                const abort = new AbortController();
                return {
                  events: adapter.translateResponse(adapter.stream(context, body, abort.signal)),
                  abort: (reason) => abort.abort(reason),
                };
              },
              recoverableError: decision,
            },
            adapter.translateRequest(ctx, [USER], []),
          ),
        );
        expect(events).toEqual([
          { kind: "message_start" },
          { kind: "text_delta", text: SYNTHETIC_REFUSAL_TEXT },
          { kind: "message_stop", stop_reason: "refusal", refusal: SYNTHETIC_REFUSAL_TEXT },
        ]);
        expect(decision).not.toHaveBeenCalled();
        expect(attempts).toBe(1);
        expect(fixture.creates).toHaveLength(1);
        expect(fixture.live.size).toBe(0);
        expect(
          fixture.controls().filter((request) => request.subtype === "interrupt"),
        ).toHaveLength(1);
        expect(fixture.archives).toEqual(agentic ? [] : ["cse_mock1"]);
        if (!agentic) {
          expect(fixture.lifecycle.lastIndexOf("reader-close")).toBeLessThan(
            fixture.lifecycle.indexOf("archive"),
          );
          return;
        }
        const requests = fixture.requests.length;
        adapter.onCompactionSucceeded(ctx);
        const error = await rejection(run(adapter, [USER, ASSISTANT, USER], undefined, ctx, []));
        expect(String(error)).toContain(SYNTHETIC_REFUSAL_TEXT);
        expect(adapter.recoverableError(error, ctx)).toMatchObject({
          kind: "fail",
          userMessage: SYNTHETIC_REFUSAL_TEXT,
        });
        await expect(run(adapter, [USER, ASSISTANT, USER], undefined, ctx, [])).rejects.toBe(error);
        expect(fixture.requests).toHaveLength(requests);
        expect(fixture.creates).toHaveLength(1);
      });
    }

    it(`keeps undelivered safety failures when interrupt also fails (agentic=${agentic})`, async () => {
      const fixture = new CloudFixture();
      fixture.failInterrupt = true;
      fixture.hooksApplied = false;
      const adapter = fixture.adapter();
      const ctx = { ...CONTEXT, agentic };
      const error = await rejection(run(adapter, [USER], undefined, ctx, []));
      expect(String(error)).toContain("local-only PreToolUse hook");
      expect(adapter.recoverableError(error, ctx)).toMatchObject({
        kind: "fail",
        userMessage: expect.stringContaining("local-only PreToolUse hook"),
      });
      expect(fixture.live.size).toBe(0);
      expect(fixture.userPosts()).toEqual([]);
      expect(fixture.archives).toEqual(agentic ? [] : ["cse_mock1"]);
    });
  }

  for (const phase of ["bootstrap", "control", "ready", "durable audit"]) {
    it(`preserves synthetic refusal in ${phase} and never rotates past it`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter();
      const refuse = () => {
        fixture.emit(syntheticAssistantError());
        fixture.emit({
          type: "result",
          subtype: "success",
          is_error: true,
          result: SYNTHETIC_REFUSAL_TEXT,
        });
        fixture.callTool();
      };
      let messages = [USER];
      if (phase === "bootstrap") fixture.bootstrap = refuse;
      if (phase === "control") fixture.onApplySettings = refuse;
      if (phase === "ready") fixture.onUser = refuse;
      if (phase === "durable audit") {
        fixture.onUser = () =>
          fixture.emit({ type: "error", error: { message: "Temporary outage" } });
        await expect(run(adapter)).rejects.toBeInstanceOf(CloudSessionInterruptedError);
        fixture.emit(syntheticAssistantError());
        messages = [USER, ASSISTANT, USER];
      }
      const events = await run(adapter, messages);
      expect(events).toContainEqual({ kind: "text_delta", text: SYNTHETIC_REFUSAL_TEXT });
      expect(events.at(-1)).toEqual({
        kind: "message_stop",
        stop_reason: "refusal",
        refusal: SYNTHETIC_REFUSAL_TEXT,
      });
      expect(events.filter((event) => event.kind === "usage")).toEqual([]);
      expect(events.filter((event) => event.kind === "error")).toEqual([]);
      expect(events.filter((event) => event.kind === "tool_call_complete")).toEqual([]);
      expect(events.filter((event) => event.kind === "message_start")).toEqual([
        { kind: "message_start" },
      ]);
      if (phase === "bootstrap" || phase === "control") expect(fixture.userPosts()).toEqual([]);
      const posts = fixture.posts.length;
      adapter.onCompactionSucceeded(CONTEXT);
      await expect(run(adapter, [USER, ASSISTANT, USER])).rejects.toThrow(SYNTHETIC_REFUSAL_TEXT);
      expect(adapter.recoverableError(new Error("Later callback failure"), CONTEXT)).toMatchObject({
        kind: "fail",
        userMessage: expect.stringContaining(SYNTHETIC_REFUSAL_TEXT),
      });
      expect(fixture.posts).toHaveLength(posts);
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.archives).toHaveLength(0);
    });
  }

  for (const markers of [
    { error: "invalid_request", is_api_error_message: undefined },
    { error: undefined, is_api_error_message: true },
  ]) {
    it(`accepts a textual synthetic error with ${JSON.stringify(markers)}`, async () => {
      const fixture = new CloudFixture();
      fixture.onUser = () => fixture.emit({ ...syntheticAssistantError(), ...markers });
      const events = await run(fixture.adapter());
      expect(events.at(-1)).toMatchObject({
        kind: "message_stop",
        stop_reason: "refusal",
        refusal: SYNTHETIC_REFUSAL_TEXT,
      });
    });
  }

  for (const invalid of [
    { label: "no marker", error: undefined, is_api_error_message: undefined },
    { label: "unknown unmarked code", error: "unrecognized_error", is_api_error_message: false },
    { label: "empty unmarked code", error: "", is_api_error_message: false },
    {
      label: "tool_use",
      content: [
        { type: "tool_use", id: "tool-use-42", name: `${MCP_TOOL_PREFIX}Calculate`, input: {} },
      ],
    },
    { label: "thinking", content: [{ type: "thinking", thinking: "not service text" }] },
    { label: "invalid text", content: [{ type: "text", text: 42 }] },
    { label: "empty content", content: [] },
    { label: "blank text", content: [{ type: "text", text: " " }] },
  ]) {
    it(`blocks pseudo-synthetic assistant with ${invalid.label} before exposing content or tools`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter();
      fixture.onUser = () => {
        const payload = syntheticAssistantError();
        fixture.emit({
          ...payload,
          ...invalid,
          message: { ...payload.message, content: invalid.content ?? payload.message.content },
        });
        fixture.callTool();
      };
      const events: ProviderEvent[] = [];
      const error = await rejection(
        (async () => {
          for await (const event of adapter.translateResponse(
            adapter.stream(
              CONTEXT,
              adapter.translateRequest(CONTEXT, [USER], [TOOL]),
              new AbortController().signal,
            ),
          ))
            events.push(event);
        })(),
      );
      expect(String(error)).toContain('requested "claude-opus-5-5", received "<synthetic>"');
      expect(error).not.toBeInstanceOf(CloudSessionInterruptedError);
      expect(events).toEqual([]);
      adapter.onCompactionSucceeded(CONTEXT);
      await expect(run(adapter, [USER, ASSISTANT, USER])).rejects.toThrow("model mismatch");
      expect(fixture.creates).toHaveLength(1);
    });
  }

  for (const model of ["claude-sonnet-5-5", undefined, ""]) {
    it(`blocks assistant model ${JSON.stringify(model)} with a clear terminal diagnostic`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter();
      fixture.onUser = () => {
        fixture.emit({
          type: "assistant",
          message: {
            id: "wrong-model",
            model,
            content: [{ type: "text", text: "Must not escape" }],
          },
        });
        fixture.callTool();
      };
      const events: ProviderEvent[] = [];
      const error = await rejection(
        (async () => {
          for await (const event of adapter.translateResponse(
            adapter.stream(
              CONTEXT,
              adapter.translateRequest(CONTEXT, [USER], [TOOL]),
              new AbortController().signal,
            ),
          ))
            events.push(event);
        })(),
      );
      expect(error).not.toBeInstanceOf(CloudSessionInterruptedError);
      expect(events).toEqual([]);
      expect(String(error)).toContain(CONTEXT.model);
      if (model) expect(String(error)).toContain(model);
      else expect(String(error)).toContain("identity is missing or invalid");
      expect(adapter.recoverableError(error, CONTEXT)).toMatchObject({
        kind: "fail",
        userMessage: expect.stringContaining(CONTEXT.model),
      });
      adapter.onCompactionSucceeded(CONTEXT);
      await expect(run(adapter, [USER, ASSISTANT, USER])).rejects.toThrow(
        String(error).replace(/^Error: /, ""),
      );
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.archives).toHaveLength(0);
    });
  }

  for (const subtype of ["model_fallback", "model_refusal_fallback", "model_consent_fallback"]) {
    it(`blocks ${subtype} before any fallback assistant or callback`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter();
      fixture.onUser = () => {
        fixture.emit({
          type: "system",
          subtype,
          original_model: CONTEXT.model,
          fallback_model: "claude-sonnet-5-5",
        });
        fixture.callTool();
      };
      const error = await rejection(run(adapter));
      expect(String(error)).toContain("model fallback");
      expect(String(error)).toContain(CONTEXT.model);
      expect(String(error)).toContain("claude-sonnet-5-5");
      expect(adapter.recoverableError(error, CONTEXT)).toMatchObject({
        kind: "fail",
        userMessage: expect.stringContaining("claude-sonnet-5-5"),
      });
      await expect(run(adapter, [USER, ASSISTANT, USER])).rejects.toThrow("model fallback");
      expect(fixture.creates).toHaveLength(1);
    });
  }

  it("preserves transient synthetic diagnostics and only recovers on new input after audit", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const diagnostic = `API Error: service overloaded. ${"Service temporarily unavailable. ".repeat(8)}Please try later.`;
    fixture.onUser = () => {
      const payload = syntheticAssistantError();
      fixture.emit({
        ...payload,
        error: "overloaded",
        message: {
          ...payload.message,
          stop_reason: "stop_sequence",
          content: [{ type: "text", text: diagnostic }],
        },
      });
    };
    const error = await rejection(run(adapter));
    expect(error).toBeInstanceOf(CloudSessionInterruptedError);
    if (!(error instanceof CloudSessionInterruptedError))
      throw new Error("Expected interrupted session");
    expect(classifyProviderError(error.cause, { provider: CONTEXT.provider })).toMatchObject({
      kind: "retry",
    });
    expect(adapter.recoverableError(error, CONTEXT)).toMatchObject({
      kind: "fail",
      userMessage: expect.stringContaining(diagnostic),
    });
    expect(String(error)).not.toContain("model mismatch");
    await expect(run(adapter)).rejects.toBe(error);
    fixture.onUser = () => fixture.finish();
    expect((await run(adapter, [USER, ASSISTANT, USER])).at(-1)).toMatchObject({
      kind: "message_stop",
      stop_reason: "stop",
    });
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toEqual(["cse_mock1"]);
  });

  for (const [code, status, kind] of [
    ["authentication_failed", 401, "fail"],
    ["oauth_org_not_allowed", 401, "fail"],
    ["billing_error", 429, "fail"],
    ["rate_limit", 429, "retry"],
    ["overloaded", 529, "retry"],
    ["invalid_request", 400, "fail"],
    ["model_not_found", 400, "fail"],
    ["server_error", 500, "retry"],
  ] as const) {
    it(`classifies synthetic ${code} using the existing provider error path`, async () => {
      const fixture = new CloudFixture();
      fixture.onUser = () => {
        const payload = syntheticAssistantError();
        fixture.emit({
          ...payload,
          error: code,
          is_api_error_message: undefined,
          message: {
            ...payload.message,
            stop_reason: "stop_sequence",
            content: [{ type: "text", text: "Service diagnostic retained verbatim." }],
          },
        });
      };
      const adapter = fixture.adapter();
      const error = await rejection(run(adapter));
      expect(error).toBeInstanceOf(CloudSessionInterruptedError);
      if (!(error instanceof CloudSessionInterruptedError))
        throw new Error("Expected interrupted session");
      expect(classifyProviderError(error.cause, { provider: CONTEXT.provider })).toMatchObject({
        kind,
        status,
      });
      expect(adapter.recoverableError(error, CONTEXT)).toMatchObject({
        kind: "fail",
        userMessage: expect.stringContaining("Service diagnostic retained verbatim."),
      });
    });
  }

  it("does not recover a synthetic policy error without an explicit refusal stop", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => {
      const payload = syntheticAssistantError();
      fixture.emit({
        ...payload,
        message: {
          ...payload.message,
          stop_reason: "stop_sequence",
          content: [{ type: "text", text: "Request blocked by acceptable use policy." }],
        },
      });
      fixture.callTool();
    };
    const adapter = fixture.adapter();
    const error = await rejection(run(adapter));
    expect(error).not.toBeInstanceOf(CloudSessionInterruptedError);
    expect(adapter.recoverableError(error, CONTEXT)).toMatchObject({
      kind: "fail",
      userMessage: "Request blocked by acceptable use policy.",
    });
    adapter.onCompactionSucceeded(CONTEXT);
    await expect(run(adapter, [USER, ASSISTANT, USER])).rejects.toThrow("acceptable use policy");
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  it("preserves explanatory refusal text even for a real assistant without stop details", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => {
      const payload = syntheticAssistantError();
      fixture.emit({ type: "assistant", message: { ...payload.message, model: CONTEXT.model } });
      fixture.emit({ type: "result", subtype: "success", is_error: false });
    };
    expect((await run(fixture.adapter())).at(-1)).toEqual({
      kind: "message_stop",
      stop_reason: "refusal",
      refusal: SYNTHETIC_REFUSAL_TEXT,
    });
  });

  it("does not replace real model or usage with synthetic zero counters", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const emitted = Promise.withResolvers<void>();
    const continueStream = Promise.withResolvers<void>();
    fixture.onUser = () => {
      fixture.assistant("real-answer", [{ type: "text", text: "Starting response" }], {
        input_tokens: 50,
        output_tokens: 7,
      });
      void continueStream.promise.then(() => fixture.emit(syntheticAssistantError()));
    };
    const events: ProviderEvent[] = [];
    const running = (async () => {
      for await (const event of adapter.translateResponse(
        adapter.stream(
          CONTEXT,
          adapter.translateRequest(CONTEXT, [USER], [TOOL]),
          new AbortController().signal,
        ),
      )) {
        events.push(event);
        if (event.kind === "usage") emitted.resolve();
      }
    })();
    await emitted.promise;
    continueStream.resolve();
    await running;
    expect(events.filter((event) => event.kind === "message_start")).toEqual([
      { kind: "message_start", id: "real-answer", model: CONTEXT.model },
    ]);
    expect(events.filter((event) => event.kind === "usage")).toHaveLength(1);
    expect(usage(events)).toMatchObject({ contextTokens: 57 });
    expect(events.at(-1)).toMatchObject({ kind: "message_stop", stop_reason: "refusal" });
  });
});

describe("Cloud interrupted sessions and serialized readers", () => {
  const nextUser: Message = {
    role: "user",
    content: [{ type: "text", text: "Continue from the saved local history." }],
  };

  for (const failure of [
    "control timeout",
    "control rejection",
    "bootstrap timeout",
    "tool catalog timeout",
    "effort confirmation",
    "HTTP 503",
    "SSE disconnect",
    "worker result",
    "worker error",
    "connection refused",
    "worker PID",
    "watchdog",
  ]) {
    it(`recovers ${failure} only with new user input and an audited snapshot`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter({ controlTimeoutMs: 20, bootstrapTimeoutMs: 20 });
      let messages = [USER];
      let ctx = CONTEXT;
      let signal = new AbortController().signal;
      if (failure === "control timeout") fixture.silentControl = "initialize";
      if (failure === "control rejection") fixture.failControl = "initialize";
      if (failure === "bootstrap timeout") fixture.bootstrap = () => {};
      if (failure === "tool catalog timeout") fixture.onToolListChanged = () => {};
      if (failure === "HTTP 503") fixture.streamStatus = 503;
      if (failure === "effort confirmation" || failure === "worker PID") {
        fixture.onUser = () => fixture.callTool();
        await run(adapter);
        messages = [USER, RESULT];
        if (failure === "worker PID") fixture.pid = 42;
        else {
          ctx = { ...CONTEXT, effort: "high" };
          fixture.onApplySettings = () => {
            fixture.settingsReply = {
              effective: fixture.current.flagSettings,
              applied: { effort: "medium", model: CONTEXT.model },
            };
          };
        }
      }
      if (failure === "SSE disconnect") {
        fixture.onUser = () => {
          for (const output of fixture.live) output.close();
          fixture.live.clear();
        };
      }
      if (failure === "worker result") {
        fixture.onUser = () =>
          fixture.emit({
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: ["Worker temporarily unavailable"],
          });
      }
      if (failure === "worker error") {
        fixture.onUser = () =>
          fixture.emit({ type: "error", error: { message: "Worker crashed" } });
      }
      if (failure === "connection refused") {
        fixture.onUser = () =>
          fixture.emit({ type: "error", error: { message: "Connection refused" } });
      }
      if (failure === "watchdog") {
        const controller = new AbortController();
        signal = controller.signal;
        fixture.onUser = () =>
          controller.abort(new DOMException("Watchdog expired", "TimeoutError"));
      }
      const body = adapter.translateRequest(ctx, messages, [TOOL]);
      const failed = () => collect(adapter.translateResponse(adapter.stream(ctx, body, signal)));
      const error = await rejection(failed());
      expect(error).toMatchObject({ name: "CloudSessionInterruptedError" });
      expect(String(error)).toContain(
        "Send a new message to continue in a new protected session from the local history; completed actions are not repeated.",
      );
      expect(adapter.recoverableError(error, ctx, 9)).toMatchObject({ kind: "fail" });
      const requestCount = fixture.requests.length;
      signal = new AbortController().signal;
      expect(await rejection(failed())).toBe(error);
      expect(fixture.requests).toHaveLength(requestCount);
      expect(fixture.creates).toHaveLength(1);
      delete fixture.silentControl;
      delete fixture.failControl;
      delete fixture.settingsReply;
      delete fixture.onApplySettings;
      fixture.streamStatus = 200;
      fixture.bootstrap = CloudFixture.prototype.bootstrap.bind(fixture);
      fixture.onToolListChanged = () =>
        fixture.rpc("tools/list", {}, "new-list", `refreshed-${fixture.changedLists}`);
      fixture.onUser = () => fixture.finish();
      const recovered = await run(adapter, [...messages, nextUser], undefined, ctx);
      expect(recovered.at(-1)).toMatchObject({ kind: "message_stop", stop_reason: "stop" });
      expect(fixture.creates).toHaveLength(2);
      expect(fixture.archives).toEqual(["cse_mock1"]);
      expect(
        fixture.requests.some(({ url }) => url.pathname === "/v1/code/sessions/cse_mock1/events"),
      ).toBe(true);
      const content = record(fixture.userPosts().at(-1)?.message, "snapshot").content;
      expect(JSON.stringify(content)).toContain("stopped unexpectedly");
      expect(JSON.stringify(content)).toContain("Do not repeat completed actions");
      expect(
        fixture.posts.filter(
          (post) =>
            post.type === "control_response" &&
            record(post.response, "response").request_id === "call-control",
        ),
      ).toHaveLength(0);
    });
  }

  it("discards a pre-creation transport failure so the same body can retry cleanly", async () => {
    const fixture = new CloudFixture();
    let unavailable = true;
    const adapter = fixture.adapter({
      fetch: async (url, init) => {
        if (unavailable) {
          unavailable = false;
          throw new TypeError("fetch failed");
        }
        return fixture.fetch(url, init);
      },
    });
    const body = adapter.translateRequest(CONTEXT, [USER], [TOOL]);
    const execute = () => collect(adapter.stream(CONTEXT, body, new AbortController().signal));
    const error = await rejection(execute());
    expect(adapter.recoverableError(error, CONTEXT)).toMatchObject({ kind: "retry" });
    await execute();
    expect(fixture.creates).toHaveLength(1);
  });

  it("retries a lost creation receipt only because no user event or callback was sent", async () => {
    const fixture = new CloudFixture();
    let lost = true;
    const adapter = fixture.adapter({
      fetch: async (url, init) => {
        const response = await fixture.fetch(url, init);
        if (lost && new URL(url).pathname === "/v1/code/sessions") {
          lost = false;
          throw Object.assign(new Error("Connection reset before creation receipt"), {
            code: "ECONNRESET",
          });
        }
        return response;
      },
    });
    const body = adapter.translateRequest(CONTEXT, [USER], [TOOL]);
    const execute = () => collect(adapter.stream(CONTEXT, body, new AbortController().signal));
    const error = await rejection(execute());
    expect(adapter.recoverableError(error, CONTEXT)).toMatchObject({ kind: "retry" });
    expect(fixture.posts).toHaveLength(0);
    await execute();
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.userPosts()).toHaveLength(1);
  });

  it("keeps a policy HTTP error terminal after creation", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter({
      fetch: (url, init) => {
        if (new URL(url).pathname.endsWith("/events") && init.method !== "POST")
          return Promise.resolve(
            Response.json({ error: { type: "policy_violation" } }, { status: 403 }),
          );
        return fixture.fetch(url, init);
      },
    });
    const error = await rejection(run(adapter));
    expect(error).not.toBeInstanceOf(CloudSessionInterruptedError);
    const count = fixture.requests.length;
    expect(await rejection(run(adapter, [USER, nextUser]))).toBe(error);
    expect(fixture.requests).toHaveLength(count);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  it("serializes two fork readers with the same key", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const ctx = { ...CONTEXT, agentId: "fork-serialized", subagentLabel: "Review" };
    const entered = Promise.withResolvers<void>();
    fixture.onUser = () => entered.resolve();
    const first = run(adapter, [USER], undefined, ctx);
    await entered.promise;
    const count = fixture.posts.length;
    const second = run(adapter, [USER, ASSISTANT, nextUser], undefined, ctx);
    await Promise.resolve();
    expect(fixture.posts).toHaveLength(count);
    fixture.onUser = () => fixture.finish();
    fixture.finish();
    expect((await first).at(-1)).toMatchObject({ kind: "message_stop", stop_reason: "stop" });
    expect((await second).at(-1)).toMatchObject({ kind: "message_stop", stop_reason: "stop" });
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.userPosts()).toHaveLength(2);
  });

  it("aborts a queued caller without releasing the next reader early or interrupting the first", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const entered = Promise.withResolvers<void>();
    fixture.onUser = () => entered.resolve();
    const first = run(adapter);
    await entered.promise;
    const caller = new AbortController();
    const waiting = rejection(run(adapter, [USER, ASSISTANT, nextUser], caller.signal));
    const third = run(adapter, [USER, ASSISTANT, nextUser]);
    caller.abort("user-cancel");
    expect(await waiting).toBe("user-cancel");
    expect(fixture.userPosts()).toHaveLength(1);
    expect(fixture.lifecycle).not.toContain("interrupt");
    fixture.onUser = () => fixture.finish();
    fixture.finish();
    await first;
    await third;
    expect(fixture.userPosts()).toHaveLength(2);
  });

  it("does not poison a parked session when a competing reader lacks its local result", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    fixture.onUser = () => fixture.callTool();
    await run(adapter);
    const count = fixture.posts.length;
    const error = await rejection(run(adapter, [USER, ASSISTANT, nextUser]));
    expect(error).toMatchObject({ name: "CloudSessionInterruptedError" });
    expect(adapter.recoverableError(error, CONTEXT)).toMatchObject({ kind: "fail" });
    expect(fixture.posts).toHaveLength(count);
    expect(fixture.live.size).toBe(1);
    expect((await run(adapter, [USER, RESULT])).at(-1)).toMatchObject({
      kind: "message_stop",
      stop_reason: "stop",
    });
    expect(fixture.creates).toHaveLength(1);
  });

  it("runs an auxiliary beside the active principal without waiting on or archiving it", async () => {
    const fixture = new CloudFixture();
    const auxiliary = new CloudFixture();
    auxiliary.sessionPrefix = "cse_aux";
    const adapter = fixture.adapter({
      fetch: (url, init) => {
        const auxCreate =
          new URL(url).pathname === "/v1/code/sessions" &&
          record(JSON.parse(String(init.body)), "create").title === "Otherside auxiliary";
        return (auxCreate || url.includes("/cse_aux") ? auxiliary : fixture).fetch(url, init);
      },
    });
    const entered = Promise.withResolvers<void>();
    fixture.onUser = () => entered.resolve();
    const first = run(adapter);
    await entered.promise;
    const aux = await run(adapter, [USER], undefined, { ...CONTEXT, agentic: false }, []);
    expect(aux.at(-1)).toMatchObject({ kind: "message_stop", stop_reason: "stop" });
    expect(auxiliary.archives).toEqual(["cse_aux1"]);
    expect(fixture.archives).toHaveLength(0);
    expect(fixture.live.size).toBe(1);
    fixture.onUser = () => fixture.finish();
    fixture.finish();
    await first;
    await run(adapter, [USER, ASSISTANT, nextUser]);
    expect(fixture.creates).toHaveLength(1);
  });

  it("serializes ephemeral callers but starts each in its own new worker", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const ctx = { ...CONTEXT, agentic: false };
    const entered = Promise.withResolvers<void>();
    fixture.onUser = () => entered.resolve();
    const first = run(adapter, [USER], undefined, ctx, []);
    await entered.promise;
    const second = run(adapter, [USER], undefined, ctx, []);
    fixture.onUser = () => fixture.finish();
    fixture.finish();
    await first;
    await second;
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toEqual(["cse_mock1", "cse_mock2"]);
  });

  it("recovers a fork without replaying its completed local call", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const ctx = { ...CONTEXT, agentId: "fork-recover", subagentLabel: "Review" };
    fixture.onUser = () => fixture.callTool();
    await run(adapter, [USER], undefined, ctx);
    fixture.onToolResult = () =>
      fixture.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Worker crashed after receiving the local result"],
      });
    const error = await rejection(run(adapter, [USER, RESULT], undefined, ctx));
    expect(error).toBeInstanceOf(CloudSessionInterruptedError);
    const count = fixture.posts.length;
    expect(await rejection(run(adapter, [USER, RESULT], undefined, ctx))).toBe(error);
    expect(fixture.posts).toHaveLength(count);
    fixture.onUser = () => fixture.finish();
    const next = await run(adapter, [USER, RESULT, nextUser], undefined, ctx);
    expect(next.some((event) => event.kind === "tool_call_complete")).toBe(false);
    expect(
      fixture.posts.filter(
        (post) =>
          post.type === "control_response" &&
          record(post.response, "response").request_id === "call-control",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(fixture.userPosts().at(-1))).toContain("tool-use-42");
    expect(fixture.archives).toEqual(["cse_mock1"]);
  });

  it("does not replay a user POST whose transport failed after server delivery", async () => {
    const fixture = new CloudFixture();
    let rejectReceipt = true;
    const adapter = fixture.adapter({
      fetch: async (url, init) => {
        const response = await fixture.fetch(url, init);
        if (rejectReceipt && fixture.userPosts().length === 1) {
          rejectReceipt = false;
          throw new TypeError("Connection reset after delivery");
        }
        return response;
      },
    });
    const error = await rejection(run(adapter));
    expect(error).toBeInstanceOf(CloudSessionInterruptedError);
    const count = fixture.requests.length;
    expect(await rejection(run(adapter))).toBe(error);
    expect(fixture.requests).toHaveLength(count);
    expect(adapter.recoverableError(error, CONTEXT)).toMatchObject({ kind: "fail" });
    await run(adapter, [USER, nextUser]);
    expect(fixture.userPosts()).toHaveLength(2);
    expect(fixture.creates).toHaveLength(2);
  });

  it("retries a failed durable audit only after another new input, not the same body", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    fixture.onUser = () =>
      fixture.emit({ type: "error", error: { message: "Worker disconnected" } });
    await rejection(run(adapter));
    fixture.historyStatus = 503;
    const messages = [USER, nextUser];
    const error = await rejection(run(adapter, messages));
    expect(error).toBeInstanceOf(CloudSessionInterruptedError);
    const count = fixture.requests.length;
    expect(await rejection(run(adapter, messages))).toBe(error);
    expect(fixture.requests).toHaveLength(count);
    expect(fixture.archives).toHaveLength(0);
    fixture.historyStatus = 200;
    fixture.onUser = () => fixture.finish();
    await run(adapter, [...messages, nextUser]);
    expect(fixture.creates).toHaveLength(2);
  });

  for (const phase of ["shutdown", "durable audit"]) {
    for (const diagnostic of [
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["AUP rejected the request"],
      },
      { type: "error", error: { type: "policy_violation" } },
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [{ type: "aup_error" }],
      },
      {
        type: "assistant",
        message: { id: "refusal", model: CONTEXT.model, stop_reason: "refusal", content: [] },
      },
      {
        type: "assistant",
        message: {
          id: "native",
          model: CONTEXT.model,
          content: [{ type: "tool_use", id: "unsafe", name: "UnknownNative", input: {} }],
        },
      },
    ]) {
      it(`keeps ${diagnostic.type} safety diagnostics from ${phase} terminal after a transient`, async () => {
        const fixture = new CloudFixture();
        const adapter = fixture.adapter();
        if (phase === "shutdown") fixture.interruptEvents = () => fixture.emit(diagnostic);
        fixture.onUser = () =>
          fixture.emit({ type: "error", error: { message: "Temporary worker error" } });
        await rejection(run(adapter));
        if (phase === "durable audit") fixture.emit(diagnostic);
        delete fixture.interruptEvents;
        fixture.onUser = () => fixture.finish();
        const error = await rejection(run(adapter, [USER, nextUser]));
        expect(error).not.toBeInstanceOf(CloudSessionInterruptedError);
        const count = fixture.requests.length;
        expect(await rejection(run(adapter, [USER, nextUser, nextUser]))).toBe(error);
        expect(fixture.requests).toHaveLength(count);
        expect(fixture.creates).toHaveLength(1);
        expect(fixture.archives).toHaveLength(0);
      });
    }
  }

  it("isolates an inherited non-agentic context from the principal namespace", () => {
    expect(cloudSessionKey({ ...CONTEXT, agentic: false })).not.toBe(cloudSessionKey(CONTEXT));
    expect(cloudSessionKey({ ...CONTEXT, agentic: true })).toBe(cloudSessionKey(CONTEXT));
  });
});

describe("Cloud idle initialize deadline recovery", () => {
  const nextUser: Message = {
    role: "user",
    content: [{ type: "text", text: "A new task after the worker went idle" }],
  };
  const nextMessages = [USER, ASSISTANT, nextUser];

  for (const failInterrupt of [false, true]) {
    it(`audits and archives a silent idle worker before sending one protected snapshot (interrupt fails=${failInterrupt})`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter({ controlTimeoutMs: 20 });
      await run(adapter);
      fixture.silentControl = "initialize";
      fixture.silentControlSession = fixture.current;
      fixture.failInterrupt = failInterrupt;
      const before = fixture.requests.length;
      const stale = adapter.translateRequest(CONTEXT, nextMessages, [TOOL]);
      const events = await run(adapter, nextMessages);
      expect(events.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
      expect(
        events.some((event) => event.kind === "tool_call_complete" || event.kind === "error"),
      ).toBe(false);
      expect(fixture.creates).toHaveLength(2);
      expect(fixture.archives).toEqual(["cse_mock1"]);
      expect(fixture.userPosts().map((post) => post.session_id)).toEqual([
        "cse_mock1",
        "cse_mock2",
      ]);
      expect(record(fixture.userPosts()[1]?.message, "snapshot").content).toEqual(
        expectedSnapshot([USER, ASSISTANT], nextUser.content),
      );
      expect(
        fixture.controls().filter((request) => request.subtype === "initialize" && request.hooks),
      ).toHaveLength(2);
      const recovery = fixture.requests.slice(before);
      const oldPosts = recovery.filter(
        ({ url, init }) =>
          url.pathname === "/v1/code/sessions/cse_mock1/events" && init.method === "POST",
      );
      expect(
        oldPosts.map(({ init }) => {
          const body = record(JSON.parse(String(init.body)), "body");
          if (!Array.isArray(body.events)) throw new Error("Missing events");
          return record(record(body.events[0], "event").payload, "payload").request;
        }),
      ).toEqual([{ subtype: "initialize" }, { subtype: "interrupt" }]);
      const interruptIndex = recovery.indexOf(oldPosts[1]!);
      const auditIndex = recovery.findIndex(
        ({ url, init }, index) =>
          index > interruptIndex &&
          url.pathname === "/v1/code/sessions/cse_mock1/events" &&
          init.method === "GET",
      );
      const archiveIndex = recovery.findIndex(({ url }) => url.pathname.endsWith("/archive"));
      const createIndex = recovery.findIndex(({ url }) => url.pathname === "/v1/code/sessions");
      expect(auditIndex).toBeGreaterThan(interruptIndex);
      expect(archiveIndex).toBeGreaterThan(auditIndex);
      expect(createIndex).toBeGreaterThan(archiveIndex);
      await expect(
        collect(adapter.stream(CONTEXT, stale, new AbortController().signal)),
      ).rejects.toThrow("predates compaction");
      await run(adapter, [...nextMessages, ASSISTANT, USER]);
      expect(fixture.creates).toHaveLength(2);
      expect(record(fixture.userPosts()[2]?.message, "incremental message").content).toEqual(
        USER.content,
      );
    });
  }

  for (const condition of [
    "pending tool",
    "active turn",
    "no new user",
    "queued inference",
    "changed history",
  ]) {
    it(`does not recover an initialize deadline with ${condition}`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter({ controlTimeoutMs: 20 });
      let messages = nextMessages;
      if (condition === "pending tool") fixture.onUser = () => fixture.callTool();
      if (condition === "active turn") {
        fixture.onUser = () =>
          fixture.assistant("unfinished", [{ type: "text", text: "Still working" }], {});
        for await (const event of adapter.translateResponse(
          adapter.stream(
            CONTEXT,
            adapter.translateRequest(CONTEXT, [USER], [TOOL]),
            new AbortController().signal,
          ),
        )) {
          if (event.kind === "text_delta") break;
        }
      } else await run(adapter);
      if (condition === "pending tool") messages = [USER, RESULT, nextUser];
      if (condition === "no new user") messages = [USER, ASSISTANT];
      if (condition === "queued inference")
        fixture.assistant("unexpected", [{ type: "text", text: "Unexpected continuation" }], {});
      if (condition === "changed history") {
        adapter.onCompactionSucceeded(CONTEXT);
        messages = [nextUser, ASSISTANT, USER];
      }
      fixture.silentControl = "initialize";
      fixture.silentControlSession = fixture.current;
      const error = await rejection(run(adapter, messages));
      expect(String(error)).toContain(
        condition === "changed history" ? "prefix changed" : "Cloud initialize timed out",
      );
      expect(adapter.recoverableError(error, CONTEXT).kind).toBe("fail");
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.archives).toEqual([]);
      expect(fixture.userPosts()).toHaveLength(1);
      expect(
        fixture.posts.some(
          (post) =>
            post.type === "control_response" &&
            record(post.response, "response").request_id === "call-control",
        ),
      ).toBe(false);
    });
  }

  it("does not treat an active infrastructure callback as an idle worker", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter({ controlTimeoutMs: 20 });
    await run(adapter);
    const control = fixture.control.bind(fixture);
    fixture.control = (payload) => {
      if (record(payload.request, "request").subtype === "initialize") {
        fixture.rpc("tools/list", {}, "idle-list", "idle-list-control");
        return;
      }
      control(payload);
    };
    fixture.beforeResponse = async (payload, init) => {
      if (record(payload.response, "response").request_id !== "idle-list-control") return;
      const signal = init.signal;
      if (!signal) throw new Error("Missing response signal");
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    await expect(run(adapter, nextMessages)).rejects.toThrow("Cloud initialize timed out");
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toEqual([]);
    expect(fixture.userPosts()).toHaveLength(1);
    expect(fixture.live.size).toBe(0);
  });

  for (const operation of ["initialize", "list_permission_rules", "apply_flag_settings"]) {
    it(`does not rotate for ${operation} deadline outside idle initialization`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter({ controlTimeoutMs: 20 });
      if (operation !== "initialize") await run(adapter);
      fixture.silentControl = operation;
      const error = await rejection(
        run(adapter, operation === "initialize" ? [USER] : nextMessages, undefined, {
          ...CONTEXT,
          effort: "high",
        }),
      );
      expect(error).toMatchObject({
        name: "CloudSessionInterruptedError",
        cause: expect.objectContaining({
          name: "TimeoutError",
          operation,
          message: `Cloud ${operation} timed out`,
          cause: expect.objectContaining({ name: "TimeoutError" }),
        }),
      });
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.archives).toEqual([]);
      expect(fixture.userPosts()).toHaveLength(operation === "initialize" ? 0 : 1);
    });
  }

  for (const cause of ["caller cancellation", "watchdog", "network timeout"]) {
    it(`does not confuse ${cause} with the initialize control deadline`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter({ controlTimeoutMs: 100 });
      await run(adapter);
      const abort = new AbortController();
      const failure = new DOMException(
        "Cloud initialize timed out",
        cause === "caller cancellation" ? "AbortError" : "TimeoutError",
      );
      const control = fixture.control.bind(fixture);
      fixture.control = (payload) => {
        if (record(payload.request, "request").subtype === "initialize") {
          if (cause === "network timeout") throw failure;
          abort.abort(failure);
          return;
        }
        control(payload);
      };
      const ctx =
        cause === "caller cancellation" ? { ...CONTEXT, abortSignal: abort.signal } : CONTEXT;
      const error = await rejection(run(adapter, nextMessages, abort.signal, ctx));
      if (cause === "caller cancellation") expect(error).toBe(failure);
      else expect(error).toMatchObject({ name: "CloudSessionInterruptedError", cause: failure });
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.archives).toEqual([]);
      expect(fixture.userPosts()).toHaveLength(1);
    });
  }

  for (const failure of [
    "AUP",
    "model mismatch",
    "account changed",
    "audit failed",
    "archive failed",
  ]) {
    it(`fails closed on ${failure} while retiring a silent idle worker`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter({ controlTimeoutMs: 20 });
      await run(adapter);
      fixture.silentControl = "initialize";
      fixture.silentControlSession = fixture.current;
      fixture.streamClosed = () => {
        delete fixture.streamClosed;
        if (failure === "AUP" || failure === "model mismatch") {
          for (let index = 0; index < 210; index++)
            fixture.emit({ type: "system", subtype: "status", status: null });
          if (failure === "AUP")
            fixture.emit({
              type: "result",
              subtype: "error_during_execution",
              is_error: true,
              errors: ["AUP failure discovered in durable history"],
            });
          else
            fixture.emit({
              type: "assistant",
              message: {
                id: "audit-model",
                model: "claude-sonnet-5-5",
                content: [{ type: "text", text: "Must not escape" }],
              },
            });
        }
        if (failure === "account changed")
          fixture.tokens = { ...fixture.tokens, accountUuid: "other-account" };
        if (failure === "audit failed") fixture.historyStatus = 503;
        if (failure === "archive failed") fixture.archiveStatus = 503;
      };
      const error = await rejection(run(adapter, nextMessages));
      const expected = {
        AUP: "AUP failure discovered in durable history",
        "model mismatch": 'requested "claude-opus-5-5", received "claude-sonnet-5-5"',
        "account changed": "identity changed",
        "audit failed": "Mock durable history unavailable",
        "archive failed": "Mock archive failed",
      }[failure];
      expect(String(error)).toContain(expected!);
      expect(adapter.recoverableError(error, CONTEXT).kind).toBe("fail");
      const requests = fixture.requests.length;
      await expect(run(adapter, nextMessages)).rejects.toBe(error);
      expect(fixture.requests).toHaveLength(requests);
      if (failure === "AUP" || failure === "model mismatch" || failure === "account changed") {
        adapter.onCompactionSucceeded(CONTEXT);
        await expect(run(adapter, [...nextMessages, nextUser])).rejects.toBe(error);
        expect(fixture.requests).toHaveLength(requests);
      }
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.archives).toEqual(failure === "archive failed" ? ["cse_mock1"] : []);
      expect(fixture.userPosts()).toHaveLength(1);
      expect(fixture.live.size).toBe(0);
    });
  }

  it("rotates at most once when the replacement initialize also times out", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter({ controlTimeoutMs: 20 });
    await run(adapter);
    fixture.silentControl = "initialize";
    const error = await rejection(run(adapter, nextMessages));
    expect(String(error)).toContain("Cloud initialize timed out");
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toEqual(["cse_mock1"]);
    expect(fixture.userPosts()).toHaveLength(1);
    expect(fixture.live.size).toBe(0);
    const requests = fixture.requests.length;
    await expect(run(adapter, nextMessages)).rejects.toBe(error);
    expect(fixture.requests).toHaveLength(requests);
  });
});

describe("Cloud ephemeral auxiliary sessions", () => {
  const auxiliary: RequestContext = { ...CONTEXT, agentic: false };

  it("archives once after success, closes its reader and removes the session state", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const events = await run(adapter, [USER], undefined, auxiliary, []);
    expect(events).toContainEqual({ kind: "text_delta", text: "42" });
    expect(events.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
    expect(fixture.archives).toEqual(["cse_mock1"]);
    expect(fixture.live.size).toBe(0);
    expect(fixture.lifecycle.lastIndexOf("reader-close")).toBeLessThan(
      fixture.lifecycle.indexOf("archive"),
    );
    expect(fixture.lifecycle).not.toContain("interrupt");

    const second = await run(adapter, [USER], undefined, auxiliary, []);
    expect(second.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toEqual(["cse_mock1", "cse_mock2"]);
    expect(fixture.userPosts()).toHaveLength(2);
    expect(fixture.permissionListings).toBe(2);
    expect(fixture.live.size).toBe(0);
  });

  for (const { fields, title } of [
    { fields: {}, title: "Otherside auxiliary" },
    { fields: { requestRole: "title" as const }, title: "Otherside title" },
    { fields: { requestRole: "memory_recall" as const }, title: "Otherside memory_recall" },
    { fields: { subagentLabel: "helper" }, title: "Otherside helper" },
    {
      fields: { requestRole: "title" as const, subagentLabel: "helper" },
      title: "Otherside title",
    },
  ]) {
    it(`uses ${title} while preserving role and label precedence`, async () => {
      const fixture = new CloudFixture();
      await run(fixture.adapter(), [USER], undefined, { ...auxiliary, ...fields }, []);
      expect(fixture.creates[0]?.title).toBe(title);
      expect(fixture.archives).toEqual(["cse_mock1"]);
    });
  }

  it("keeps a successful response and no state when its archive fails, without writing to the terminal", async () => {
    const fixture = new CloudFixture();
    fixture.archiveStatus = 503;
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const adapter = fixture.adapter();
      const events = await run(adapter, [USER], undefined, auxiliary, []);
      expect(events).toContainEqual({ kind: "text_delta", text: "42" });
      expect(events.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
      expect(warn).not.toHaveBeenCalled();
      expect(fixture.archives).toEqual(["cse_mock1"]);
      expect(fixture.live.size).toBe(0);

      fixture.archiveStatus = 200;
      await run(adapter, [USER], undefined, auxiliary, []);
      expect(fixture.creates).toHaveLength(2);
      expect(fixture.archives).toEqual(["cse_mock1", "cse_mock2"]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("bounds auxiliary archive with its own timeout without failing the response", async () => {
    const fixture = new CloudFixture();
    const caller = new AbortController();
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) =>
      nativeTimeout(milliseconds === 5_000 ? 10 : milliseconds),
    );
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    fixture.beforeArchive = async (init) => {
      const signal = init.signal;
      if (!signal) throw new Error("Archive requires a timeout signal");
      expect(signal).not.toBe(caller.signal);
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    try {
      const events = await run(fixture.adapter(), [USER], caller.signal, auxiliary, []);
      expect(events.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
      expect(timeout).toHaveBeenCalledWith(5_000);
      expect(warn).not.toHaveBeenCalled();
      expect(fixture.archives).toEqual(["cse_mock1"]);
      expect(caller.signal.aborted).toBe(false);
      expect(fixture.live.size).toBe(0);
    } finally {
      timeout.mockRestore();
      warn.mockRestore();
    }
  });

  it("archives a worker error without hiding it and starts the next auxiliary independently", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () =>
      fixture.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Auxiliary worker failed"],
      });
    const adapter = fixture.adapter();
    const error = await rejection(run(adapter, [USER], undefined, auxiliary, []));
    expect(error).toBeInstanceOf(CloudSessionInterruptedError);
    expect(String(error)).toContain("Auxiliary worker failed");
    expect(adapter.recoverableError(error, auxiliary)).toMatchObject({ kind: "fail" });
    expect(fixture.archives).toEqual(["cse_mock1"]);
    expect(fixture.live.size).toBe(0);

    fixture.onUser = () => fixture.finish();
    const next = await run(adapter, [USER], undefined, auxiliary, []);
    expect(next.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toEqual(["cse_mock1", "cse_mock2"]);
  });

  it("archives on bootstrap failure even when interrupt cleanup also fails", async () => {
    const fixture = new CloudFixture();
    fixture.hooksApplied = false;
    fixture.failInterrupt = true;
    await expect(run(fixture.adapter(), [USER], undefined, auxiliary, [])).rejects.toThrow(
      "local-only PreToolUse hook",
    );
    expect(fixture.userPosts()).toHaveLength(0);
    expect(fixture.archives).toEqual(["cse_mock1"]);
    expect(fixture.live.size).toBe(0);
  });

  it("preserves the unregistered-tool error and archives an auxiliary tools/call", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () =>
      fixture.rpc(
        "tools/call",
        { name: "Calculate", arguments: {}, _meta: { "claudecode/toolUseId": "auxiliary-use" } },
        "auxiliary-rpc",
        "auxiliary-call",
      );
    await expect(run(fixture.adapter(), [USER], undefined, auxiliary, [])).rejects.toThrow(
      "Cloud requested an unregistered local tool: Calculate",
    );
    expect(fixture.archives).toEqual(["cse_mock1"]);
    expect(fixture.live.size).toBe(0);
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" &&
          record(post.response, "response").request_id === "auxiliary-call",
      ),
    ).toBe(false);
  });

  it("never hands off a registered tool to a non-agentic caller", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    await expect(run(fixture.adapter(), [USER], undefined, auxiliary)).rejects.toThrow(
      "non-agentic",
    );
    expect(fixture.archives).toEqual(["cse_mock1"]);
    expect(fixture.live.size).toBe(0);
    expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" &&
          record(post.response, "response").request_id === "call-control",
      ),
    ).toBe(false);
  });

  it("interrupts and archives an aborted auxiliary with a signal independent of its caller", async () => {
    const fixture = new CloudFixture();
    const caller = new AbortController();
    const reason = new DOMException("Auxiliary cancelled", "AbortError");
    fixture.onUser = () => caller.abort(reason);
    fixture.beforeArchive = (init) => {
      expect(init.signal).not.toBe(caller.signal);
      expect(init.signal?.aborted).toBe(false);
    };
    const adapter = fixture.adapter();
    const ctx = { ...auxiliary, abortSignal: caller.signal };
    await expect(run(adapter, [USER], caller.signal, ctx, [])).rejects.toThrow(
      "Auxiliary cancelled",
    );
    expect(fixture.archives).toEqual(["cse_mock1"]);
    expect(fixture.lifecycle.indexOf("interrupt")).toBeLessThan(
      fixture.lifecycle.lastIndexOf("reader-close"),
    );
    expect(fixture.lifecycle.lastIndexOf("reader-close")).toBeLessThan(
      fixture.lifecycle.indexOf("archive"),
    );
    expect(fixture.live.size).toBe(0);
    expect(fixture.controls().filter((control) => control.subtype === "interrupt")).toHaveLength(1);

    fixture.onUser = () => fixture.finish();
    await run(adapter, [USER], undefined, auxiliary, []);
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toEqual(["cse_mock1", "cse_mock2"]);
  });

  it("does not archive an auxiliary through a newly logged-in account", async () => {
    const fixture = new CloudFixture();
    fixture.streamClosed = () => {
      fixture.tokens = { ...fixture.tokens, accountUuid: "changed-account" };
    };
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const adapter = fixture.adapter();
      const events = await run(adapter, [USER], undefined, auxiliary, []);
      expect(events.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
      expect(fixture.archives).toHaveLength(0);
      expect(warn).not.toHaveBeenCalled();
      expect(fixture.live.size).toBe(0);

      delete fixture.streamClosed;
      await run(adapter, [USER], undefined, auxiliary, []);
      expect(fixture.creates).toHaveLength(2);
      expect(fixture.archives).toEqual(["cse_mock2"]);
    } finally {
      warn.mockRestore();
    }
  });

  for (const { name, fields } of [
    { name: "default main", fields: {} },
    { name: "agentic main", fields: { agentic: true } },
    { name: "fork", fields: { agentic: true, agentId: "fork", agentOwnerId: "owner" } },
    { name: "subagent", fields: { agentic: true, subagentLabel: "helper" } },
    { name: "compaction", fields: { agentic: true, isCompaction: true } },
  ]) {
    it(`preserves ${name} continuity without archiving after success`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter();
      const ctx = { ...CONTEXT, ...fields };
      const first = await run(adapter, [USER], undefined, ctx);
      expect(first.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
      expect(fixture.archives).toHaveLength(0);
      const second = await run(adapter, [USER, ASSISTANT, USER], undefined, ctx);
      expect(second.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.creates[0]?.title).toBe(`Otherside ${ctx.subagentLabel ?? "session"}`);
      expect(fixture.archives).toHaveLength(0);
      expect(fixture.userPosts()).toHaveLength(2);
    });
  }
});

describe("Cloud protected local SDK sessions", () => {
  it("waits for the successful SSE response before posting its first control", async () => {
    const fixture = new CloudFixture();
    const requested = Promise.withResolvers<void>();
    const open = Promise.withResolvers<void>();
    fixture.beforeStream = () => {
      requested.resolve();
      return open.promise;
    };
    const running = run(fixture.adapter());
    await requested.promise;
    expect(fixture.posts).toHaveLength(0);
    expect(fixture.live.size).toBe(0);
    open.resolve();
    const events = await running;
    expect(events.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
    expect(fixture.ephemeralControlsDropped).toBe(0);
  });

  it("queues ephemeral control responses before POST receipts and reuses SSE for the next tool round", async () => {
    const fixture = new CloudFixture();
    fixture.holdControlReceipts = true;
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter({ controlTimeoutMs: 500 });
    const first = await run(adapter);
    expect(first.at(-1)).toEqual({ kind: "message_stop", stop_reason: "tool_calls" });
    expect(fixture.live.size).toBe(1);
    expect(fixture.lifecycle).not.toContain("reader-close");
    expect(fixture.lifecycle).not.toContain("interrupt");
    const second = await run(adapter, [USER, RESULT]);
    expect(second.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
    expect(fixture.lifecycle.filter((event) => event === "sse-open")).toHaveLength(1);
    expect(fixture.live.size).toBe(0);
    expect(fixture.ephemeralControlsDelivered).toBe(10);
    expect(fixture.ephemeralControlsDropped).toBe(0);
    expect(
      fixture.current.events.some(
        (event) => event.source === "worker" && event.payload.type === "control_response",
      ),
    ).toBe(false);
    expect(fixture.current.events.some((event) => event.source === "client")).toBe(true);
    const controlIds = fixture.posts
      .filter((post) => post.type === "control_request")
      .map((post) => String(post.request_id));
    for (const id of controlIds) {
      const read = fixture.lifecycle.indexOf(`control-read:${id}`);
      const receipt = fixture.lifecycle.indexOf(`receipt:${id}`);
      expect(read).toBeGreaterThanOrEqual(0);
      expect(receipt).toBeGreaterThan(read);
    }
    expect(fixture.userPosts()).toHaveLength(1);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.unreadControlReceipts.size).toBe(0);
  });

  it("keeps SSE alive and services SDK handshakes while the harness delays its local result", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const caller = new AbortController();
    const adapter = fixture.adapter();
    const ctx = { ...CONTEXT, abortSignal: caller.signal };
    const first = await run(adapter, [USER], caller.signal, ctx);
    expect(first.filter((event) => event.kind === "tool_call_complete")).toHaveLength(1);
    expect(fixture.live.size).toBe(1);
    const listed = fixture.waitForResponse("parked-list");
    fixture.rpc("tools/list", {}, "parked-list-rpc", "parked-list");
    await listed;
    const initialized = fixture.waitForResponse("parked-initialize");
    fixture.rpc(
      "initialize",
      { protocolVersion: "2025-03-26" },
      "parked-init-rpc",
      "parked-initialize",
    );
    await initialized;
    const hooked = fixture.waitForResponse("parked-hook");
    fixture.hook("parked-hook", `${MCP_TOOL_PREFIX}Calculate`);
    await hooked;
    expect(responseFor(fixture, "parked-hook")).toEqual({});
    expect(responseFor(fixture, "parked-list")).toMatchObject({
      mcp_response: { id: "parked-list-rpc", result: { tools: [{ name: "Calculate" }] } },
    });
    expect(fixture.lifecycle).not.toContain("reader-close");
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" &&
          record(post.response, "response").request_id === "call-control",
      ),
    ).toBe(false);
    expect((await run(adapter, [USER, RESULT], caller.signal, ctx)).at(-1)).toEqual({
      kind: "message_stop",
      stop_reason: "stop",
    });
    expect(fixture.lifecycle.filter((event) => event === "sse-open")).toHaveLength(1);
    expect(fixture.live.size).toBe(0);
    const before = fixture.posts.length;
    caller.abort("user-cancel");
    expect(fixture.posts).toHaveLength(before);
    fixture.onUser = () => fixture.finish();
    await run(adapter, [USER, RESULT, ASSISTANT, USER]);
    // The already-aborted previous caller must not rotate or stop this completed session.
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.controls().some((request) => request.subtype === "interrupt")).toBe(false);
  });

  it("queues parallel SDK calls and permissions without executing outside a harness round", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    fixture.onToolResult = () => undefined;
    const permitted = fixture.waitForResponse("parallel-permission");
    fixture.hook("parallel-hook", `${MCP_TOOL_PREFIX}Calculate`);
    fixture.emit({
      type: "control_request",
      request_id: "parallel-permission",
      request: {
        subtype: "can_use_tool",
        tool_name: `${MCP_TOOL_PREFIX}Calculate`,
        tool_use_id: "parallel-use",
        input: { expression: "1+2" },
      },
    });
    fixture.rpc(
      "tools/call",
      {
        name: "Calculate",
        arguments: { expression: "1+2" },
        _meta: { "claudecode/toolUseId": "parallel-use" },
      },
      "parallel-rpc",
      "parallel-control",
    );
    await permitted;
    const barrier = fixture.waitForResponse("after-parallel-list");
    fixture.rpc("tools/list", {}, "after-parallel-rpc", "after-parallel-list");
    await barrier;
    expect(responseFor(fixture, "parallel-permission")).toEqual({
      behavior: "allow",
      updatedInput: { expression: "1+2" },
    });
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" &&
          record(post.response, "response").request_id === "parallel-control",
      ),
    ).toBe(false);
    const second = await run(adapter, [USER, RESULT]);
    expect(second.filter((event) => event.kind === "tool_call_complete")).toEqual([
      {
        kind: "tool_call_complete",
        id: "parallel-use",
        name: "Calculate",
        input: { expression: "1+2" },
      },
    ]);
    expect(fixture.permissionListings).toBe(2);
    expect(fixture.live.size).toBe(1);
    fixture.responsePosted = (payload) => {
      if (record(payload.response, "response").request_id === "parallel-control") fixture.finish();
    };
    const secondResult: Message = {
      role: "tool",
      content: [{ type: "tool_result", tool_use_id: "parallel-use", content: "3" }],
    };
    expect((await run(adapter, [USER, RESULT, secondResult])).at(-1)).toEqual({
      kind: "message_stop",
      stop_reason: "stop",
    });
    expect(responseFor(fixture, "parallel-control")).toMatchObject({
      mcp_response: { id: "parallel-rpc", result: { content: [{ type: "text", text: "3" }] } },
    });
    expect(fixture.lifecycle.filter((event) => event === "sse-open")).toHaveLength(1);
    expect(fixture.live.size).toBe(0);
  });

  it("interrupts and closes the live connection immediately when the caller aborts between tool rounds", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    const caller = new AbortController();
    await run(adapter, [USER], caller.signal, { ...CONTEXT, abortSignal: caller.signal });
    expect(fixture.live.size).toBe(1);
    const closed = Promise.withResolvers<void>();
    fixture.streamClosed = () => closed.resolve();
    caller.abort("user-cancel");
    await closed.promise;
    expect(fixture.live.size).toBe(0);
    expect(fixture.controls().filter((request) => request.subtype === "interrupt")).toHaveLength(1);
    await expect(run(adapter, [USER])).rejects.toThrow("new user prompt or local rejection");
    expect(fixture.creates).toHaveLength(1);
  });

  it("stops a locally rejected tool turn without sending its result or aborting the root controller", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    const root = new AbortController();
    const unrelatedBackground = new AbortController();
    const ctx = { ...CONTEXT, abortSignal: root.signal };
    await run(adapter, [USER], root.signal, ctx);
    const rejection: Message = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-use-42",
          content: "User denied the local action",
          is_error: true,
        },
      ],
    };
    const persisted = [USER, rejection];
    fixture.interruptEvents = (payload) => {
      fixture.emit({
        type: "control_response",
        response: { subtype: "success", request_id: payload.request_id },
      });
      fixture.emit({
        type: "user",
        message: { role: "user", content: "[Request interrupted by user]" },
      });
      fixture.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [],
      });
    };
    await adapter.onToolTurnStopped(ctx);
    expect(fixture.live.size).toBe(0);
    expect(root.signal.aborted).toBe(false);
    expect(unrelatedBackground.signal.aborted).toBe(false);
    expect(fixture.controls().filter((request) => request.subtype === "interrupt")).toHaveLength(1);
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" &&
          record(post.response, "response").request_id === "call-control",
      ),
    ).toBe(false);
    expect(persisted[1]).toEqual(rejection);
    const before = fixture.posts.length;
    await adapter.onToolTurnStopped(ctx);
    expect(fixture.posts).toHaveLength(before);
    await expect(run(adapter, [USER])).rejects.toThrow("a new user prompt is required");
    await expect(run(adapter, persisted)).rejects.toThrow("a new user prompt is required");
    expect(fixture.posts).toHaveLength(before);
    expect(fixture.archives).toHaveLength(0);
    root.abort("user-cancel");
    expect(fixture.posts).toHaveLength(before);
    delete fixture.interruptEvents;
    fixture.onUser = () => fixture.finish();
    const next: Message = {
      role: "user",
      content: [{ type: "text", text: "A new task after the rejection" }],
    };
    const events = await run(adapter, [...persisted, next]);
    expect(events.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
    expect(events.some((event) => event.kind.startsWith("tool_call"))).toBe(false);
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toEqual(["cse_mock1"]);
    expect(JSON.stringify(fixture.userPosts()[1])).toContain("User denied the local action");
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" &&
          record(post.response, "response").request_id === "call-control",
      ),
    ).toBe(false);
  });

  it("treats a stopped tool turn without a matching pending session as a safe no-op", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    await adapter.onToolTurnStopped(CONTEXT);
    expect(fixture.requests).toHaveLength(0);
    await run(adapter);
    const before = fixture.requests.length;
    await adapter.onToolTurnStopped(CONTEXT);
    expect(fixture.requests).toHaveLength(before);
    expect(fixture.controls().some((request) => request.subtype === "interrupt")).toBe(false);
    fixture.onUser = () => fixture.callTool();
    const fork = { ...CONTEXT, agentId: "rejection-child", agentOwnerId: "rejection-owner" };
    await run(adapter, [USER], undefined, fork);
    const forkBefore = fixture.requests.length;
    await adapter.onToolTurnStopped(CONTEXT);
    expect(fixture.requests).toHaveLength(forkBefore);
    expect(fixture.live.size).toBe(1);
    await adapter.onToolTurnStopped(fork);
    expect(fixture.live.size).toBe(0);
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toHaveLength(0);
  });

  it("denies a pending hook before closing a locally rejected tool turn", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    const posted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.beforeResponse = async (payload) => {
      const response = record(payload.response, "response");
      if (response.request_id !== "pending-rejection-hook") return;
      const result = record(response.response, "hook result");
      if (!result.hookSpecificOutput) {
        posted.resolve();
        await release.promise;
      } else release.resolve();
    };
    fixture.hook("pending-rejection-hook", `${MCP_TOOL_PREFIX}Calculate`);
    await posted.promise;
    await adapter.onToolTurnStopped(CONTEXT);
    const replies = fixture.posts.filter(
      (post) =>
        post.type === "control_response" &&
        record(post.response, "response").request_id === "pending-rejection-hook",
    );
    expect(
      replies.some((post) => {
        const result = record(record(post.response, "response").response, "hook result");
        return (
          !!result.hookSpecificOutput &&
          record(result.hookSpecificOutput, "hook output").permissionDecision === "deny"
        );
      }),
    ).toBe(true);
    expect(fixture.lifecycle.indexOf("hook-deny")).toBeLessThan(
      fixture.lifecycle.indexOf("interrupt"),
    );
    expect(fixture.live.size).toBe(0);
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" &&
          record(post.response, "response").request_id === "call-control",
      ),
    ).toBe(false);
  });

  it("detaches rejection cleanup failure and requires a new input plus archive", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    const root = new AbortController();
    await run(adapter, [USER], root.signal, { ...CONTEXT, abortSignal: root.signal });
    fixture.failInterrupt = true;
    await expect(adapter.onToolTurnStopped(CONTEXT)).rejects.toThrow("deny/interrupt cleanup");
    expect(fixture.live.size).toBe(0);
    expect(root.signal.aborted).toBe(false);
    await expect(run(adapter, [USER, RESULT])).rejects.toBeInstanceOf(CloudSessionInterruptedError);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
    fixture.onUser = () => fixture.finish();
    await run(adapter, [USER, RESULT, USER]);
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toEqual(["cse_mock1"]);
  });

  it("preserves AUP delivered during local rejection shutdown as a terminal failure", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    fixture.interruptEvents = (payload) => {
      fixture.emit({
        type: "control_response",
        response: { subtype: "success", request_id: payload.request_id },
      });
      fixture.emit({
        type: "user",
        message: { role: "user", content: "[Request interrupted by user]" },
      });
      fixture.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["AUP refusal during rejected turn shutdown"],
      });
    };
    await expect(adapter.onToolTurnStopped(CONTEXT)).rejects.toThrow(
      "AUP refusal during rejected turn shutdown",
    );
    expect(fixture.live.size).toBe(0);
    await expect(run(adapter, [USER, RESULT, USER])).rejects.toThrow(
      "AUP refusal during rejected turn shutdown",
    );
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  it("does not send rejection cleanup through a newly logged-in account", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    fixture.tokens = { ...fixture.tokens, accountUuid: "new-account-after-local-deny" };
    const before = fixture.requests.length;
    await expect(adapter.onToolTurnStopped(CONTEXT)).rejects.toThrow("identity changed");
    expect(fixture.requests).toHaveLength(before);
    expect(fixture.live.size).toBe(0);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  it("fails closed if the parked stream disconnects without replaying a completed local result", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    const interrupt = Promise.withResolvers<void>();
    const control = fixture.control.bind(fixture);
    fixture.control = (payload) => {
      control(payload);
      if (record(payload.request, "request").subtype === "interrupt") interrupt.resolve();
    };
    for (const output of fixture.live) output.close();
    fixture.live.clear();
    await interrupt.promise;
    await expect(run(adapter, [USER, RESULT])).rejects.toThrow("protection cannot be revalidated");
    expect(fixture.creates).toHaveLength(1);
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" &&
          record(post.response, "response").request_id === "call-control",
      ),
    ).toBe(false);
  });

  it("checks account identity before servicing callbacks on a parked live connection", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    fixture.tokens = { ...fixture.tokens, accountUuid: "other-parked-account" };
    const before = fixture.posts.length;
    const closed = Promise.withResolvers<void>();
    fixture.streamClosed = () => closed.resolve();
    fixture.rpc("tools/list", {}, "foreign-account-rpc", "foreign-account-control");
    await closed.promise;
    await expect(run(adapter, [USER, RESULT])).rejects.toThrow("identity changed");
    expect(fixture.posts).toHaveLength(before);
    expect(fixture.live.size).toBe(0);
    expect(fixture.creates).toHaveLength(1);
  });

  it("confirms disabled local tool auto-background after hook initialization and before SDK registration", async () => {
    const fixture = new CloudFixture();
    const control = fixture.control.bind(fixture);
    const waiting = Promise.withResolvers<Record<string, unknown>>();
    fixture.control = (payload) => {
      if (record(payload.request, "request").subtype === "get_settings") {
        waiting.resolve(payload);
        return;
      }
      control(payload);
    };
    const caller = new AbortController();
    const pending = run(fixture.adapter(), [USER], caller.signal);
    try {
      const request = await Promise.race([
        waiting.promise,
        pending.then(() => {
          throw new Error("Cloud released user data without confirming local tool auto-background");
        }),
      ]);
      expect(fixture.controls().map((request) => request.subtype)).toEqual([
        "initialize",
        "apply_flag_settings",
        "get_settings",
      ]);
      expect(fixture.controls()[1]).toEqual({
        subtype: "apply_flag_settings",
        settings: { env: { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0" } },
      });
      expect(fixture.posts.some((post) => post.type === "user")).toBe(false);
      expect(JSON.stringify(fixture.posts)).not.toContain("17+25");
      fixture.control = control;
      control(request);
      await pending;
      expect(fixture.controls()[3]).toEqual({
        subtype: "set_max_thinking_tokens",
        thinking_display: "summarized",
      });
      expect(fixture.controls()[4]?.subtype).toBe("mcp_set_servers");
    } finally {
      caller.abort("test cleanup");
      await pending.catch(() => undefined);
    }
  });

  for (const subtype of ["apply_flag_settings", "get_settings"]) {
    it(`fails closed before SDK registration when local tool auto-background ${subtype} fails`, async () => {
      const fixture = new CloudFixture();
      fixture.failControl = subtype;
      const adapter = fixture.adapter();
      await expect(run(adapter)).rejects.toThrow(`Cloud ${subtype} control failed`);
      expect(fixture.controls().some((request) => request.subtype === "mcp_set_servers")).toBe(
        false,
      );
      expect(fixture.posts.some((post) => post.type === "user")).toBe(false);
      expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
      expect(fixture.live.size).toBe(0);
      const before = fixture.requests.length;
      await expect(run(adapter, [USER])).rejects.toThrow(subtype);
      expect(fixture.requests).toHaveLength(before);
      delete fixture.failControl;
      await run(adapter, [USER, ASSISTANT, USER]);
      expect(fixture.archives).toEqual(["cse_mock1"]);
    });
  }

  for (const confirmation of [
    { label: "missing effective settings", settings: {} },
    { label: "missing env", settings: { effective: {} } },
    { label: "missing env key", settings: { effective: { env: {} } } },
    {
      label: "default timer",
      settings: { effective: { env: { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "120000" } } },
    },
    {
      label: "numeric zero",
      settings: { effective: { env: { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: 0 } } },
    },
    {
      label: "null env value",
      settings: { effective: { env: { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: null } } },
    },
    {
      label: "applied rather than effective",
      settings: { applied: { env: { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0" } } },
    },
    {
      label: "source overridden in effective settings",
      settings: {
        sources: [
          {
            source: "flagSettings",
            settings: { env: { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0" } },
          },
        ],
        effective: { env: { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "120000" } },
      },
    },
  ]) {
    it(`fails closed before SDK registration for unconfirmed local tool auto-background (${confirmation.label})`, async () => {
      const fixture = new CloudFixture();
      fixture.settingsReply = confirmation.settings;
      const adapter = fixture.adapter();
      await expect(run(adapter)).rejects.toThrow("auto-background");
      expect(fixture.controls().some((request) => request.subtype === "mcp_set_servers")).toBe(
        false,
      );
      expect(fixture.posts.some((post) => post.type === "user")).toBe(false);
      expect(fixture.live.size).toBe(0);
      const before = fixture.requests.length;
      await expect(run(adapter, [USER])).rejects.toThrow("auto-background");
      expect(fixture.requests).toHaveLength(before);
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.archives).toHaveLength(0);
      delete fixture.settingsReply;
      await run(adapter, [USER, ASSISTANT, USER]);
      expect(fixture.creates).toHaveLength(2);
      expect(fixture.archives).toEqual(["cse_mock1"]);
    });
  }

  it("registers the SDK with the harness-owned local tool timeout", async () => {
    const fixture = new CloudFixture();
    await run(fixture.adapter());
    expect(CLOUD_LOCAL_TOOL_TIMEOUT_MS).toBe(2_147_483_647);
    expect(fixture.controls().find((control) => control.subtype === "mcp_set_servers")).toEqual({
      subtype: "mcp_set_servers",
      servers: {
        otherside: { type: "sdk", name: "otherside", timeout: CLOUD_LOCAL_TOOL_TIMEOUT_MS },
      },
    });
  });

  for (const cause of [
    "cancelled-string",
    "cancelled-number",
    "result",
    "auto-background-string",
    "auto-background-blocks",
    "auto-background-then-result",
  ]) {
    it(`recovers local call abandonment from ${cause} only with new user input and the actual local result snapshot`, async () => {
      const fixture = new CloudFixture();
      fixture.onUser = () =>
        fixture.callTool("Calculate", cause === "cancelled-number" ? 42 : "rpc-42");
      const adapter = fixture.adapter();
      const first = await run(adapter);
      expect(first.filter((event) => event.kind === "tool_call_complete")).toHaveLength(1);
      if (cause.startsWith("auto-background")) {
        fixture.backgroundCall(
          cause === "auto-background-blocks"
            ? [{ type: "text", text: AUTO_BACKGROUND_NOTICE }]
            : AUTO_BACKGROUND_NOTICE,
        );
        if (cause === "auto-background-then-result") fixture.finish();
      } else if (cause === "result") fixture.finish();
      else fixture.cancelCall(cause === "cancelled-number" ? 42 : "rpc-42");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fixture.live.size).toBe(0);
      const error = await rejection(run(adapter, [USER, RESULT]));
      const actionable =
        "Cloud stopped waiting for a local tool result before it finished. The local result is kept in the conversation; send a new message to continue in a new protected session from the local history. Completed actions are not repeated.";
      expect(error).toBeInstanceOf(CloudLocalCallAbandonedError);
      expect(error).toMatchObject({ name: "CloudLocalCallAbandonedError", message: actionable });
      expect(adapter.recoverableError(error, CONTEXT, 9)).toEqual({
        kind: "fail",
        reason: actionable,
        failure: "unclassified",
        userMessage: actionable,
      });
      const before = fixture.requests.length;
      expect(await rejection(run(adapter, [USER]))).toBe(error);
      expect(await rejection(run(adapter, [USER, RESULT]))).toBe(error);
      const rejected: Message = {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-use-42",
            content: "Local tool stopped",
            is_error: true,
          },
        ],
      };
      expect(await rejection(run(adapter, [USER, rejected]))).toBe(error);
      for (const marker of [
        { type: "text" as const, text: "[Request interrupted by user]" },
        { type: "text" as const, text: "A reminder", reminder_type: "system" },
      ]) {
        expect(
          await rejection(run(adapter, [USER, RESULT, { role: "user", content: [marker] }])),
        ).toBe(error);
      }
      expect(fixture.requests).toHaveLength(before);
      expect(fixture.archives).toHaveLength(0);
      expect(fixture.creates).toHaveLength(1);
      const history: Message[] = [
        USER,
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-use-42",
              name: "Calculate",
              input: { expression: "17+25" },
            },
          ],
        },
        RESULT,
      ];
      const next: Message = {
        role: "user",
        content: [
          { type: "text", text: "Use the completed local result. Do not execute it again." },
        ],
      };
      fixture.onUser = () => fixture.finish();
      const recovered = await run(adapter, [...history, next]);
      expect(recovered.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
      expect(recovered.some((event) => event.kind.startsWith("tool_call"))).toBe(false);
      expect(fixture.archives).toEqual(["cse_mock1"]);
      expect(fixture.creates).toHaveLength(2);
      const content = record(fixture.userPosts()[1]?.message, "recovery message").content;
      if (!Array.isArray(content)) throw new Error("Expected snapshot content");
      const notice = record(content[0], "abandonment notice");
      expect(notice.text).toContain("stopped waiting for a local tool result");
      expect(notice.text).toContain("Do not repeat completed actions");
      expect(notice.text).toContain("Unfinished actions require a new explicit user request");
      expect(content.slice(1)).toEqual(expectedSnapshot(history, next.content));
      const recoveryRequests = fixture.requests.slice(before);
      const catchUp = recoveryRequests.findIndex(
        ({ url, init }) =>
          init.method === "GET" && url.pathname === "/v1/code/sessions/cse_mock1/events",
      );
      const archive = recoveryRequests.findIndex(
        ({ url }) => url.pathname === "/v1/code/sessions/cse_mock1/archive",
      );
      expect(catchUp).toBeGreaterThanOrEqual(0);
      expect(archive).toBeGreaterThan(catchUp);
      expect(
        recoveryRequests.filter(
          ({ url, init }) =>
            init.method === "POST" && url.pathname === "/v1/code/sessions/cse_mock1/events",
        ),
      ).toHaveLength(0);
      expect(
        fixture.posts.some(
          (post) =>
            post.type === "control_response" &&
            record(post.response, "response").request_id === "call-control",
        ),
      ).toBe(false);
      expect(
        fixture.controls().filter((control) => control.subtype === "initialize" && control.hooks),
      ).toHaveLength(2);
    });
  }

  for (const cause of ["cancelled", "result", "auto-background"]) {
    it(`detects local call abandonment from ${cause} during foreground boundary revalidation before sending its result`, async () => {
      const fixture = new CloudFixture();
      fixture.onUser = () => fixture.callTool();
      const adapter = fixture.adapter();
      await run(adapter);
      const control = fixture.control.bind(fixture);
      fixture.control = (payload) => {
        if (record(payload.request, "request").subtype === "initialize") {
          if (cause === "auto-background") fixture.backgroundCall();
          else if (cause === "result") fixture.finish();
          else fixture.cancelCall();
        }
        control(payload);
      };
      await expect(run(adapter, [USER, RESULT])).rejects.toBeInstanceOf(
        CloudLocalCallAbandonedError,
      );
      expect(
        fixture.posts.some(
          (post) =>
            post.type === "control_response" &&
            record(post.response, "response").request_id === "call-control",
        ),
      ).toBe(false);
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.archives).toHaveLength(0);
    });
  }

  it("detects local call abandonment even while an infrastructure reply receipt is blocked", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const caller = new AbortController();
    const adapter = fixture.adapter();
    await run(adapter, [USER], caller.signal);
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.beforeResponse = async (payload) => {
      if (record(payload.response, "response").request_id === "blocked-list") {
        blocked.resolve();
        await release.promise;
      }
    };
    fixture.rpc("tools/list", {}, "blocked-list-rpc", "blocked-list");
    await blocked.promise;
    fixture.streamClosed = () => release.resolve();
    try {
      fixture.cancelCall();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fixture.live.size).toBe(0);
      await expect(run(adapter, [USER, RESULT])).rejects.toBeInstanceOf(
        CloudLocalCallAbandonedError,
      );
    } finally {
      release.resolve();
      caller.abort("user-cancel");
    }
  });

  it("cancels a prepared local result POST if abandonment arrives during its credential lookup", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let holdResultCredentials = false;
    const adapter = fixture.adapter({
      currentTokens: async () => {
        if (holdResultCredentials) {
          holdResultCredentials = false;
          blocked.resolve();
          await release.promise;
        }
        return fixture.tokens;
      },
    });
    await run(adapter);
    const control = fixture.control.bind(fixture);
    fixture.control = (payload) => {
      control(payload);
      if (record(payload.request, "request").subtype === "list_permission_rules") {
        holdResultCredentials = true;
      }
    };
    const continued = rejection(run(adapter, [USER, RESULT]));
    try {
      await blocked.promise;
      const closed = Promise.withResolvers<void>();
      fixture.streamClosed = () => closed.resolve();
      fixture.cancelCall();
      await closed.promise;
      release.resolve();
      expect(await continued).toBeInstanceOf(CloudLocalCallAbandonedError);
      expect(
        fixture.posts.some(
          (post) =>
            post.type === "control_response" &&
            record(post.response, "response").request_id === "call-control",
        ),
      ).toBe(false);
    } finally {
      release.resolve();
      await continued.catch(() => undefined);
    }
  });

  it("does not abandon a local result whose winning echo precedes auto-background, cancellation and final result before its POST receipt", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.beforeResponse = async (payload) => {
      if (record(payload.response, "response").request_id === "call-control") {
        blocked.resolve();
        await release.promise;
      }
    };
    fixture.onToolResult = () => undefined;
    const continued = run(adapter, [USER, RESULT]);
    try {
      await blocked.promise;
      fixture.backgroundCall();
      fixture.cancelCall();
      fixture.finish();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fixture.controls().some((control) => control.subtype === "interrupt")).toBe(false);
      release.resolve();
      expect((await continued).at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.archives).toHaveLength(0);
    } finally {
      release.resolve();
      await continued.catch(() => undefined);
    }
  });

  for (const sample of [
    { label: "RPC id", toolUseId: "rpc-42" },
    { label: "control id", toolUseId: "call-control" },
    { label: "another tool use", toolUseId: "other-tool-use" },
    { label: "foreign server", content: AUTO_BACKGROUND_NOTICE.replace("otherside/", "remote/") },
    { label: "another local tool", content: AUTO_BACKGROUND_NOTICE.replace("Calculate", "Read") },
    { label: "quoted notice", content: `Quoted output: ${AUTO_BACKGROUND_NOTICE}` },
    { label: "ordinary output", content: "A local tool is still running in the background" },
    { label: "normal text block", blockType: "text" },
    { label: "non-text content", content: [{ type: "image", text: AUTO_BACKGROUND_NOTICE }] },
    { label: "client echo", source: "client" as const },
  ]) {
    it(`ignores uncorrelated local tool auto-background text (${sample.label})`, async () => {
      const fixture = new CloudFixture();
      fixture.onUser = () => fixture.callTool();
      const caller = new AbortController();
      const adapter = fixture.adapter();
      await run(adapter, [USER], caller.signal);
      try {
        fixture.emit(
          {
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: sample.blockType ?? "tool_result",
                  tool_use_id: sample.toolUseId ?? "tool-use-42",
                  content: sample.content ?? AUTO_BACKGROUND_NOTICE,
                },
              ],
            },
          },
          sample.source ?? "worker",
        );
        const listed = fixture.waitForResponse("after-uncorrelated-background");
        fixture.rpc("tools/list", {}, "background-list-rpc", "after-uncorrelated-background");
        await listed;
        expect(fixture.live.size).toBe(1);
        expect((await run(adapter, [USER, RESULT])).at(-1)).toEqual({
          kind: "message_stop",
          stop_reason: "stop",
        });
        expect(responseFor(fixture, "call-control")).toMatchObject({
          mcp_response: { id: "rpc-42" },
        });
        expect(fixture.controls().some((request) => request.subtype === "interrupt")).toBe(false);
        expect(fixture.creates).toHaveLength(1);
      } finally {
        caller.abort("test cleanup");
      }
    });
  }

  for (const unrelatedId of ["call-control", "tool-use-42", "42"]) {
    it(`does not abandon an outstanding local RPC for unrelated cancellation ${unrelatedId}`, async () => {
      const fixture = new CloudFixture();
      fixture.onUser = () => fixture.callTool("Calculate", 42);
      const adapter = fixture.adapter();
      await run(adapter);
      fixture.cancelCall(unrelatedId);
      const listed = fixture.waitForResponse("after-unrelated-cancel");
      fixture.rpc("tools/list", {}, "after-cancel-rpc", "after-unrelated-cancel");
      await listed;
      expect(fixture.live.size).toBe(1);
      expect((await run(adapter, [USER, RESULT])).at(-1)).toEqual({
        kind: "message_stop",
        stop_reason: "stop",
      });
      expect(responseFor(fixture, "call-control")).toMatchObject({ mcp_response: { id: 42 } });
      expect(fixture.controls().some((control) => control.subtype === "interrupt")).toBe(false);
      expect(fixture.creates).toHaveLength(1);
    });
  }

  for (const terminal of [
    {
      label: "AUP",
      payload: {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["AUP after abandonment"],
      },
      error: "AUP after abandonment",
    },
    {
      label: "worker error",
      payload: { type: "error", errors: ["Worker failed after abandonment"] },
      error: "Worker failed after abandonment",
    },
    {
      label: "refusal",
      payload: {
        type: "assistant",
        message: {
          id: "abandoned-refusal",
          model: CONTEXT.model,
          content: [],
          stop_reason: "refusal",
          stop_details: { type: "refusal", explanation: "Refusal after abandonment" },
        },
      },
      error: "Refusal after abandonment",
    },
    {
      label: "native intent",
      payload: {
        type: "assistant",
        message: {
          id: "abandoned-native",
          model: CONTEXT.model,
          content: [
            {
              type: "tool_use",
              id: "native-after-abandonment",
              name: "UnprotectedRemoteTool",
              input: {},
            },
          ],
        },
      },
      error: "nonlocal tool",
    },
  ]) {
    for (const phase of ["shutdown", "durable history"]) {
      it(`classifies ${terminal.label} in ${phase} after local call abandonment`, async () => {
        const fixture = new CloudFixture();
        fixture.onUser = () => fixture.callTool();
        const adapter = fixture.adapter();
        await run(adapter);
        if (phase === "shutdown") {
          fixture.interruptEvents = (payload) => {
            fixture.emit(terminal.payload);
            fixture.emit({
              type: "control_response",
              response: { subtype: "success", request_id: payload.request_id },
            });
          };
        }
        fixture.cancelCall();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(fixture.live.size).toBe(0);
        if (phase === "durable history") fixture.emit(terminal.payload);
        if (terminal.label === "worker error") {
          await expect(run(adapter, [USER, RESULT])).rejects.toBeInstanceOf(
            CloudLocalCallAbandonedError,
          );
          fixture.onUser = () => fixture.finish();
          await run(adapter, [USER, RESULT, USER]);
          expect(fixture.archives).toEqual(["cse_mock1"]);
          expect(fixture.creates).toHaveLength(2);
          return;
        }
        const error = await rejection(run(adapter, [USER, RESULT, USER]));
        expect(error).not.toBeInstanceOf(CloudLocalCallAbandonedError);
        expect(String(error)).toContain(terminal.error);
        const before = fixture.requests.length;
        expect(await rejection(run(adapter, [USER, RESULT, USER]))).toBe(error);
        expect(fixture.requests).toHaveLength(before);
        expect(adapter.recoverableError(new CloudLocalCallAbandonedError(), CONTEXT)).toMatchObject(
          { kind: "fail", reason: expect.stringContaining(terminal.error) },
        );
        expect(fixture.creates).toHaveLength(1);
        expect(fixture.archives).toHaveLength(0);
      });
    }
  }

  for (const phase of ["before notice", "shutdown"]) {
    it(`keeps an AUP ${phase} terminal despite local tool auto-background`, async () => {
      const fixture = new CloudFixture();
      fixture.onUser = () => fixture.callTool();
      const adapter = fixture.adapter();
      await run(adapter);
      const terminal = {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["AUP with local auto-background"],
      };
      if (phase === "before notice") fixture.emit(terminal);
      else {
        fixture.interruptEvents = (payload) => {
          fixture.emit(terminal);
          fixture.emit({
            type: "control_response",
            response: { subtype: "success", request_id: payload.request_id },
          });
        };
      }
      fixture.backgroundCall();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const error = await rejection(run(adapter, [USER, RESULT, USER]));
      expect(error).not.toBeInstanceOf(CloudLocalCallAbandonedError);
      expect(String(error)).toContain("AUP with local auto-background");
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.archives).toHaveLength(0);
      expect(fixture.live.size).toBe(0);
    });
  }

  it("keeps a terminal result with pending local calls terminal instead of abandonment", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    fixture.emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["AUP while local call pending"],
    });
    fixture.cancelCall();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const error = await rejection(run(adapter, [USER, RESULT, USER]));
    expect(error).not.toBeInstanceOf(CloudLocalCallAbandonedError);
    expect(String(error)).toContain("AUP while local call pending");
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  it("does not recover local call abandonment with an unconfirmed native denial", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => {
      fixture.nativeIntent("ToolSearch");
      fixture.callTool();
    };
    const adapter = fixture.adapter();
    await run(adapter);
    fixture.cancelCall();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.live.size).toBe(0);
    await expect(run(adapter, [USER, RESULT, USER])).rejects.toThrow(
      "without confirming all native tool denial results",
    );
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  it("checks bound identity before auditing local call abandonment", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    fixture.cancelCall();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.live.size).toBe(0);
    fixture.tokens = { ...fixture.tokens, accountUuid: "other-abandoned-account" };
    const before = fixture.requests.length;
    await expect(run(adapter, [USER, RESULT, USER])).rejects.toThrow("identity changed");
    expect(fixture.requests).toHaveLength(before);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  for (const stop of ["Esc", "local rejection"]) {
    it(`does not classify cancelled notifications during our ${stop} interrupt as local call abandonment`, async () => {
      const fixture = new CloudFixture();
      fixture.onUser = () => fixture.callTool();
      const adapter = fixture.adapter();
      const caller = new AbortController();
      const ctx = { ...CONTEXT, abortSignal: caller.signal };
      await run(adapter, [USER], caller.signal, ctx);
      fixture.interruptEvents = (payload) => {
        fixture.cancelCall();
        fixture.emit({
          type: "control_response",
          response: { subtype: "success", request_id: payload.request_id },
        });
        fixture.emit({
          type: "user",
          message: { role: "user", content: "[Request interrupted by user]" },
        });
        fixture.emit({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [EDE_DIAGNOSTIC],
        });
      };
      if (stop === "Esc") caller.abort("user-cancel");
      else await adapter.onToolTurnStopped(ctx);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const error = await rejection(run(adapter, [USER]));
      expect(error).not.toBeInstanceOf(CloudLocalCallAbandonedError);
      expect(String(error)).toContain(
        stop === "Esc" ? "new user prompt or local rejection" : "a new user prompt is required",
      );
      delete fixture.interruptEvents;
      fixture.onUser = () => fixture.finish();
      const recovered = await run(adapter, [USER, RESULT, USER]);
      expect(recovered.some((event) => event.kind.startsWith("tool_call"))).toBe(false);
      const content = record(fixture.userPosts()[1]?.message, "recovery snapshot").content;
      if (!Array.isArray(content)) throw new Error("Expected snapshot content");
      expect(record(content[0], "interruption notice").text).toContain("explicitly interrupted");
      expect(
        fixture.posts.some(
          (post) =>
            post.type === "control_response" &&
            record(post.response, "response").request_id === "call-control",
        ),
      ).toBe(false);
    });
  }

  it("stops on another client's reply to a pending SDK call and never resends a completed local result", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    expect(
      (await run(adapter)).filter((event) => event.kind === "tool_call_complete"),
    ).toHaveLength(1);
    const closed = Promise.withResolvers<void>();
    fixture.streamClosed = () => closed.resolve();
    fixture.foreignReply("call-control");
    await closed.promise;
    expect(fixture.live.size).toBe(0);
    await expect(run(adapter, [USER, RESULT])).rejects.toThrow(
      "Another client answered this Cloud session's local tool callback",
    );
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
    expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" &&
          record(post.response, "response").request_id === "call-control",
      ),
    ).toBe(false);
  });

  it("recovers typed callback contention only after durable audit and the replacement tools/list echo", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    const first = await run(adapter);
    expect(first.filter((event) => event.kind === "tool_call_complete")).toHaveLength(1);
    const closed = Promise.withResolvers<void>();
    fixture.streamClosed = () => closed.resolve();
    fixture.foreignReply("call-control");
    await closed.promise;
    const error = await rejection(run(adapter, [USER, RESULT]));
    const actionable =
      "Another client answered this Cloud session's local tool callback (for example, the same session open in a browser). Close other clients of this session, then send a new message: Otherside continues in a new protected session from the local history and does not repeat completed actions.";
    expect(error).toBeInstanceOf(CloudCallbackContentionError);
    expect(error).toMatchObject({ name: "CloudCallbackContentionError", message: actionable });
    expect(adapter.recoverableError(error, CONTEXT, 9)).toEqual({
      kind: "fail",
      reason: actionable,
      failure: "unclassified",
      userMessage: actionable,
    });
    const before = fixture.requests.length;
    expect(await rejection(run(adapter, [USER]))).toBe(error);
    expect(
      await rejection(
        run(adapter, [
          USER,
          {
            ...RESULT,
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-use-42",
                is_error: true,
                content: "Local tool already stopped",
              },
            ],
          },
        ]),
      ),
    ).toBe(error);
    expect(
      await rejection(
        run(adapter, [
          USER,
          RESULT,
          { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
        ]),
      ),
    ).toBe(error);
    expect(fixture.requests).toHaveLength(before);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
    fixture.onUser = () => fixture.finish();
    const historical: Message[] = [
      USER,
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-use-42",
            name: "Calculate",
            input: { expression: "17+25" },
          },
        ],
      },
      RESULT,
    ];
    const current: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text: "The other client is closed. Answer using the completed result; do not run it again.",
        },
      ],
    };
    const notified = Promise.withResolvers<void>();
    fixture.onToolListChanged = () => notified.resolve();
    const echo = holdResponseEcho(fixture, "updated-list-2");
    const caller = new AbortController();
    const recovering = run(adapter, [...historical, current], caller.signal);
    let recovered: ProviderEvent[];
    try {
      await notified.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fixture.userPosts()).toHaveLength(1);
      fixture.rpc("tools/list", {}, "updated-2", "updated-list-2");
      await echo.posted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fixture.userPosts()).toHaveLength(1);
      echo.release();
      recovered = await recovering;
    } finally {
      echo.release();
      caller.abort();
      await recovering.catch(() => undefined);
    }
    expect(recovered.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
    expect(recovered.some((event) => event.kind.startsWith("tool_call"))).toBe(false);
    expect(fixture.archives).toEqual(["cse_mock1"]);
    expect(fixture.creates).toHaveLength(2);
    const content = record(fixture.userPosts()[1]?.message, "recovery user message").content;
    if (!Array.isArray(content)) throw new Error("Expected snapshot content");
    const notice = record(content[0], "contention notice");
    expect(notice.type).toBe("text");
    expect(notice.text).toContain("another client answered a local tool callback");
    expect(notice.text).toContain("Do not repeat completed actions");
    expect(notice.text).toContain("Unfinished actions require a new explicit user request");
    expect(content.slice(1)).toEqual(expectedSnapshot(historical, current.content));
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" &&
          record(post.response, "response").request_id === "call-control",
      ),
    ).toBe(false);
    const recoveryRequests = fixture.requests.slice(before);
    const catchUp = recoveryRequests.findIndex(
      ({ url, init }) =>
        init.method === "GET" && url.pathname === "/v1/code/sessions/cse_mock1/events",
    );
    const archive = recoveryRequests.findIndex(
      ({ url }) => url.pathname === "/v1/code/sessions/cse_mock1/archive",
    );
    expect(catchUp).toBeGreaterThanOrEqual(0);
    expect(
      BigInt(recoveryRequests[catchUp]?.url.searchParams.get("cursor") ?? "0"),
    ).toBeGreaterThan(0n);
    expect(archive).toBeGreaterThan(catchUp);
    const oldPosts = recoveryRequests.filter(
      ({ url, init }) =>
        init.method === "POST" && url.pathname === "/v1/code/sessions/cse_mock1/events",
    );
    expect(oldPosts).toHaveLength(0);
    expect(
      fixture.controls().filter((control) => control.subtype === "initialize" && control.hooks),
    ).toHaveLength(2);
  });

  for (const terminal of [
    {
      label: "AUP",
      payload: {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["AUP after contention"],
      },
      error: "AUP after contention",
    },
    {
      label: "worker error",
      payload: { type: "error", errors: ["Worker failed after contention"] },
      error: "Worker failed after contention",
    },
    {
      label: "structured refusal",
      payload: {
        type: "assistant",
        message: {
          id: "contended-refusal",
          model: CONTEXT.model,
          content: [],
          stop_reason: "refusal",
          stop_details: { type: "refusal", explanation: "Refusal after contention" },
        },
      },
      error: "Refusal after contention",
    },
    {
      label: "uncorrelated interruption",
      payload: { type: "result", subtype: "error_during_execution", is_error: true, errors: [] },
      error: "error_during_execution",
    },
  ]) {
    it(`classifies durable ${terminal.label} after contention before rotating`, async () => {
      const fixture = new CloudFixture();
      fixture.onUser = () => fixture.callTool();
      const adapter = fixture.adapter();
      await run(adapter);
      const closed = Promise.withResolvers<void>();
      fixture.streamClosed = () => closed.resolve();
      fixture.foreignReply("call-control");
      await closed.promise;
      fixture.emit(terminal.payload);
      if (terminal.label === "worker error" || terminal.label === "uncorrelated interruption") {
        await expect(run(adapter, [USER, RESULT])).rejects.toBeInstanceOf(
          CloudCallbackContentionError,
        );
        fixture.onUser = () => fixture.finish();
        await run(adapter, [USER, RESULT, USER]);
        expect(fixture.creates).toHaveLength(2);
        expect(fixture.archives).toEqual(["cse_mock1"]);
        return;
      }
      await expect(run(adapter, [USER, RESULT, USER])).rejects.toThrow(terminal.error);
      const before = fixture.requests.length;
      await expect(run(adapter, [USER, RESULT, USER])).rejects.toThrow(terminal.error);
      expect(fixture.requests).toHaveLength(before);
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.archives).toHaveLength(0);
      expect(fixture.userPosts()).toHaveLength(1);
      expect(adapter.recoverableError(new CloudCallbackContentionError(), CONTEXT)).toMatchObject({
        kind: "fail",
        reason: expect.stringContaining(terminal.error),
      });
    });
  }

  it("does not let contention mask a terminal AUP observed before the competing reply", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    const closed = Promise.withResolvers<void>();
    fixture.streamClosed = () => closed.resolve();
    fixture.emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["AUP before contention"],
    });
    fixture.foreignReply("call-control");
    await closed.promise;
    await expect(run(adapter, [USER, RESULT, USER])).rejects.toThrow("AUP before contention");
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  it("does not let contention mask terminal AUP received during its shutdown", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    fixture.interruptEvents = (payload) => {
      fixture.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["AUP during contention shutdown"],
      });
      fixture.emit({
        type: "control_response",
        response: { subtype: "success", request_id: payload.request_id },
      });
    };
    const closed = Promise.withResolvers<void>();
    fixture.streamClosed = () => closed.resolve();
    fixture.foreignReply("call-control");
    await closed.promise;
    await expect(run(adapter, [USER, RESULT, USER])).rejects.toThrow(
      "AUP during contention shutdown",
    );
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  for (const resultPhase of ["shutdown", "durable-drain"]) {
    for (const errors of [[], [EDE_DIAGNOSTIC]]) {
      it(`accepts only the correlated contention interruption result in ${resultPhase} with errors=${JSON.stringify(errors)}`, async () => {
        const fixture = new CloudFixture();
        fixture.onUser = () => fixture.callTool();
        const adapter = fixture.adapter();
        const first = await run(adapter);
        expect(first.filter((event) => event.kind === "tool_call_complete")).toHaveLength(1);
        const interrupted = {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors,
          result: "",
          stop_reason: "tool_use",
        };
        fixture.interruptEvents = (payload) => {
          fixture.emit({
            type: "control_response",
            response: { subtype: "success", request_id: payload.request_id },
          });
          fixture.emit({
            type: "user",
            message: { role: "user", content: "[Request interrupted by user]" },
          });
          if (resultPhase === "shutdown") fixture.emit(interrupted);
        };
        const closed = Promise.withResolvers<void>();
        fixture.streamClosed = () => closed.resolve();
        fixture.foreignReply("call-control");
        await closed.promise;
        if (resultPhase === "durable-drain") fixture.emit(interrupted);
        delete fixture.interruptEvents;
        await expect(run(adapter, [USER, RESULT])).rejects.toBeInstanceOf(
          CloudCallbackContentionError,
        );
        expect(fixture.creates).toHaveLength(1);
        expect(fixture.archives).toHaveLength(0);
        fixture.onUser = () => fixture.finish();
        const result = await run(adapter, [USER, RESULT, USER]);
        expect(result.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
        expect(result.some((event) => event.kind.startsWith("tool_call"))).toBe(false);
        expect(fixture.creates).toHaveLength(2);
        expect(fixture.archives).toEqual(["cse_mock1"]);
        const content = record(fixture.userPosts()[1]?.message, "recovery snapshot").content;
        if (!Array.isArray(content)) throw new Error("Expected snapshot content");
        expect(record(content[0], "contention notice").text).toContain(
          "Do not repeat completed actions",
        );
        expect(content.slice(1)).toEqual(expectedSnapshot([USER, RESULT], USER.content));
        expect(
          fixture.posts.some(
            (post) =>
              post.type === "control_response" &&
              record(post.response, "response").request_id === "call-control",
          ),
        ).toBe(false);
      });
    }
  }

  for (const invalid of ["AUP refusal", "missing ACK", "missing marker"]) {
    it(`does not ignore uncorrelated EDE diagnostics or ${invalid} after contention`, async () => {
      const fixture = new CloudFixture();
      fixture.onUser = () => fixture.callTool();
      const adapter = fixture.adapter();
      await run(adapter);
      fixture.interruptEvents = (payload) => {
        fixture.emit({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: invalid === "missing ACK" ? "unrelated-control" : payload.request_id,
          },
        });
        if (invalid !== "missing marker")
          fixture.emit({
            type: "user",
            message: { role: "user", content: "[Request interrupted by user]" },
          });
        fixture.emit({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: invalid === "AUP refusal" ? [EDE_DIAGNOSTIC, "AUP refusal"] : [EDE_DIAGNOSTIC],
          result: "",
          stop_reason: "tool_use",
        });
      };
      const closed = Promise.withResolvers<void>();
      fixture.streamClosed = () => closed.resolve();
      fixture.foreignReply("call-control");
      await closed.promise;
      const before = fixture.requests.length;
      if (invalid !== "AUP refusal") {
        await expect(run(adapter, [USER, RESULT])).rejects.toBeInstanceOf(
          CloudCallbackContentionError,
        );
        expect(fixture.requests).toHaveLength(before);
        delete fixture.interruptEvents;
        fixture.onUser = () => fixture.finish();
        await run(adapter, [USER, RESULT, USER]);
        expect(fixture.creates).toHaveLength(2);
        expect(fixture.archives).toEqual(["cse_mock1"]);
        return;
      }
      const error = await rejection(run(adapter, [USER, RESULT, USER]));
      expect(error).not.toBeInstanceOf(CloudCallbackContentionError);
      expect(String(error)).toContain("AUP refusal");
      expect(await rejection(run(adapter, [USER, RESULT, USER]))).toBe(error);
      expect(fixture.requests).toHaveLength(before);
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.archives).toHaveLength(0);
      expect(fixture.userPosts()).toHaveLength(1);
    });
  }

  it("drains all durable pages before deciding whether contention can recover", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    const closed = Promise.withResolvers<void>();
    fixture.streamClosed = () => closed.resolve();
    fixture.foreignReply("call-control");
    await closed.promise;
    for (let index = 0; index < 205; index++)
      fixture.emit({ type: "system", subtype: "status", status: "fixture" });
    fixture.emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["AUP on second durable page"],
    });
    const before = fixture.requests.length;
    await expect(run(adapter, [USER, RESULT, USER])).rejects.toThrow("AUP on second durable page");
    expect(
      fixture.requests
        .slice(before)
        .filter(
          ({ url }) =>
            url.pathname === "/v1/code/sessions/cse_mock1/events" && url.searchParams.has("cursor"),
        ),
    ).toHaveLength(2);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  it("detaches a failed durable drain without archiving or replaying a contended session", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    const closed = Promise.withResolvers<void>();
    fixture.streamClosed = () => closed.resolve();
    fixture.foreignReply("call-control");
    await closed.promise;
    fixture.historyStatus = 503;
    const error = await rejection(run(adapter, [USER, RESULT, USER]));
    expect(String(error)).toContain("Mock durable history unavailable");
    expect(error).not.toBeInstanceOf(CloudCallbackContentionError);
    fixture.historyStatus = 200;
    const before = fixture.requests.length;
    expect(await rejection(run(adapter, [USER, RESULT, USER]))).toBe(error);
    expect(fixture.requests).toHaveLength(before);
    expect(adapter.recoverableError(error, CONTEXT)).toMatchObject({ kind: "fail" });
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  it("checks bound account identity before draining or recovering contention", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    const closed = Promise.withResolvers<void>();
    fixture.streamClosed = () => closed.resolve();
    fixture.foreignReply("call-control");
    await closed.promise;
    fixture.tokens = { ...fixture.tokens, accountUuid: "other-contention-account" };
    const before = fixture.requests.length;
    await expect(run(adapter, [USER, RESULT, USER])).rejects.toThrow("identity changed");
    expect(fixture.requests).toHaveLength(before);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  it("never answers an observed stolen hook and explicitly denies other pending hooks during contention shutdown", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.beforeResponse = async (payload) => {
      if (record(payload.response, "response").request_id === "blocked-handshake") {
        blocked.resolve();
        await release.promise;
      }
    };
    fixture.rpc("tools/list", {}, "blocked-rpc", "blocked-handshake");
    await blocked.promise;
    const closed = Promise.withResolvers<void>();
    fixture.streamClosed = () => {
      release.resolve();
      closed.resolve();
    };
    fixture.hook("stolen-queued-hook", `${MCP_TOOL_PREFIX}Calculate`);
    fixture.hook("unanswered-queued-hook", `${MCP_TOOL_PREFIX}Calculate`);
    fixture.foreignReply("stolen-queued-hook");
    await closed.promise;
    expect(await rejection(run(adapter, [USER, RESULT]))).toBeInstanceOf(
      CloudCallbackContentionError,
    );
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" &&
          record(post.response, "response").request_id === "stolen-queued-hook",
      ),
    ).toBe(false);
    expect(responseFor(fixture, "unanswered-queued-hook")).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
    expect(fixture.lifecycle.indexOf("hook-deny")).toBeLessThan(
      fixture.lifecycle.indexOf("interrupt"),
    );
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  it("keeps unknown native intent queued before contention terminal during its recovery audit", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    fixture.nativeIntent("UnprotectedRemoteTool");
    const closed = Promise.withResolvers<void>();
    fixture.streamClosed = () => closed.resolve();
    fixture.foreignReply("call-control");
    await closed.promise;
    const error = await rejection(run(adapter, [USER, RESULT, USER]));
    expect(String(error)).toContain("nonlocal tool");
    expect(error).not.toBeInstanceOf(CloudCallbackContentionError);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  it("does not recover contention while a native denial remains unconfirmed", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => {
      fixture.nativeIntent("ToolSearch");
      fixture.callTool();
    };
    const adapter = fixture.adapter();
    await run(adapter);
    const closed = Promise.withResolvers<void>();
    fixture.streamClosed = () => closed.resolve();
    fixture.foreignReply("call-control");
    await closed.promise;
    await expect(run(adapter, [USER, RESULT, USER])).rejects.toThrow(
      "without confirming all native tool denial results",
    );
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  for (const requestId of ["local-hook", "list-before-echo"]) {
    it(`does not confuse locally enqueued replies with a winning echo for ${requestId}`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter();
      fixture.beforeEcho = (payload) => {
        if (
          payload.type === "control_response" &&
          record(payload.response, "response").request_id === requestId
        )
          fixture.foreignReply(requestId);
      };
      fixture.onUser = () => {
        if (requestId === "local-hook") fixture.callTool();
        else fixture.rpc("tools/list", {}, "foreign-rpc", requestId);
      };
      await expect(run(adapter)).rejects.toThrow(
        "Another client answered this Cloud session's local tool callback",
      );
      expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
      expect(fixture.creates).toHaveLength(1);
    });
  }

  it("ignores another client's late error only after our successful reply's ordered echo won", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    fixture.beforeResponse = (payload) => {
      if (record(payload.response, "response").request_id === "call-control")
        fixture.foreignReply("call-control");
    };
    const final = await run(adapter, [USER, RESULT]);
    expect(final.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
    expect(fixture.controls().some((request) => request.subtype === "interrupt")).toBe(false);
    const echoes = fixture.current.events.filter(
      (event) =>
        event.source === "client" &&
        event.payload.type === "control_response" &&
        record(event.payload.response, "response").request_id === "call-control",
    );
    expect(echoes).toHaveLength(2);
    expect(record(echoes[0]?.payload.response, "first response").subtype).toBe("success");
    expect(record(echoes[1]?.payload.response, "second response").subtype).toBe("error");
    expect(BigInt(echoes[0]?.sequence_num ?? "0")).toBeLessThan(
      BigInt(echoes[1]?.sequence_num ?? "0"),
    );
  });

  it("does not treat source-worker responses or unrelated client replies as callback collisions", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    fixture.foreignReply("call-control", "worker");
    fixture.foreignReply("unrelated-control");
    const barrier = fixture.waitForResponse("source-barrier");
    fixture.rpc("tools/list", {}, "source-barrier-rpc", "source-barrier");
    await barrier;
    expect((await run(adapter, [USER, RESULT])).at(-1)).toEqual({
      kind: "message_stop",
      stop_reason: "stop",
    });
    expect(fixture.controls().some((request) => request.subtype === "interrupt")).toBe(false);
  });

  it("reports a collision that races the local-result POST before our ordered echo", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    fixture.beforeEcho = (payload) => {
      if (
        payload.type === "control_response" &&
        record(payload.response, "response").request_id === "call-control"
      )
        fixture.foreignReply("call-control");
    };
    await expect(run(adapter, [USER, RESULT])).rejects.toThrow(
      "Another client answered this Cloud session's local tool callback",
    );
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
    await expect(run(adapter, [USER, RESULT])).rejects.toThrow(
      "Another client answered this Cloud session's local tool callback",
    );
  });

  it("keeps a terminal worker error received between tool rounds ahead of any local result", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    const closed = Promise.withResolvers<void>();
    fixture.streamClosed = () => closed.resolve();
    fixture.emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["AUP failure while local tool ran"],
    });
    await closed.promise;
    await expect(run(adapter, [USER, RESULT])).rejects.toThrow("AUP failure while local tool ran");
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" &&
          record(post.response, "response").request_id === "call-control",
      ),
    ).toBe(false);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
  });

  it("publishes the harness-selected schemas and bootstrap connection eagerly without mutating them", () => {
    const schema = Object.freeze({
      type: "object",
      properties: Object.freeze({ path: Object.freeze({ type: "string" }) }),
      required: Object.freeze(["path"]),
    });
    const tools = Object.freeze([
      Object.freeze({ name: "Read", description: "Read locally", inputSchema: schema }),
      Object.freeze({ ...CLOUD_CONNECT_TOOL }),
    ]);
    const result = mcpHandshake({ jsonrpc: "2.0", id: "eager-list", method: "tools/list" }, tools);
    expect(result).toEqual({
      jsonrpc: "2.0",
      id: "eager-list",
      result: {
        tools: tools.map((tool) => ({ ...tool, _meta: { "anthropic/alwaysLoad": true } })),
      },
    });
    const published = record(result?.result, "tools result").tools;
    if (!Array.isArray(published)) throw new Error("Expected published tools");
    expect(record(published[0], "published schema").inputSchema).toBe(schema);
    expect(tools[0]).not.toHaveProperty("_meta");
    expect(tools[1]).not.toHaveProperty("_meta");
  });

  it("forces ask only for bootstrap Connect while real SDK callbacks and native denies keep their policies", async () => {
    const fixture = new CloudFixture();
    fixture.bootstrapNativeAttempt = true;
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    expect(responseFor(fixture, "bootstrap-hook")).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: expect.any(String),
      },
    });
    expect(responseFor(fixture, "bootstrap-native-hook")).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(responseFor(fixture, "bootstrap-permission")).toMatchObject({
      behavior: "allow",
      updatedPermissions: [{ type: "addRules", destination: "session", behavior: "deny" }],
    });
    expect(responseFor(fixture, "local-hook")).toEqual({});
    expect(responseFor(fixture, "permission-control")).toEqual({
      behavior: "allow",
      updatedInput: { expression: "17+25" },
    });
    const asks = fixture.posts.filter((payload) => {
      if (payload.type !== "control_response") return false;
      const response = record(record(payload.response, "control response").response, "result");
      return (
        !!response.hookSpecificOutput &&
        record(response.hookSpecificOutput, "hook output").permissionDecision === "ask"
      );
    });
    expect(asks).toHaveLength(1);
    expect(fixture.controls().some((request) => request.subtype === "set_permission_mode")).toBe(
      false,
    );
    expect((await run(adapter, [USER, RESULT])).at(-1)).toEqual({
      kind: "message_stop",
      stop_reason: "stop",
    });
  });

  it("fails closed if the worker skips can_use_tool after the bootstrap ask", async () => {
    const fixture = new CloudFixture();
    const response = fixture.response.bind(fixture);
    fixture.response = (payload) => {
      if (record(payload.response, "response").request_id === "bootstrap-hook") {
        expect(
          record(record(payload.response, "control response").response, "result"),
        ).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
        fixture.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Skipped permission callback",
        });
      } else response(payload);
    };
    const adapter = fixture.adapter();
    await expect(run(adapter)).rejects.toThrow("no connection can_use_tool callback was received");
    await expect(run(adapter)).rejects.toThrow("no connection can_use_tool callback was received");
    expect(fixture.userPosts()).toHaveLength(0);
    expect(fixture.creates).toHaveLength(1);
    expect(
      fixture.posts.some(
        (payload) =>
          payload.type === "control_response" &&
          record(payload.response, "response").request_id === "bootstrap-call",
      ),
    ).toBe(false);
  });

  it("distinguishes a bootstrap with no permission callback from an approved connection with no RPC", async () => {
    const missingPermission = new CloudFixture();
    missingPermission.missingBootstrapCallback = true;
    await expect(run(missingPermission.adapter())).rejects.toThrow(
      "no connection can_use_tool callback was received",
    );
    expect(missingPermission.userPosts()).toHaveLength(0);
    const missingCall = new CloudFixture();
    const response = missingCall.response.bind(missingCall);
    missingCall.response = (payload) => {
      if (record(payload.response, "response").request_id === "bootstrap-permission") {
        missingCall.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "No connection invoked",
        });
      } else response(payload);
    };
    await expect(run(missingCall.adapter())).rejects.toThrow(
      "received 0 connection tools/call callbacks after permission approval",
    );
    expect(missingCall.userPosts()).toHaveLength(0);
    expect(missingCall.creates).toHaveLength(1);
  });

  it("preserves an SDK-not-found bootstrap diagnostic rather than replacing it with a call-count error", async () => {
    const fixture = new CloudFixture();
    const response = fixture.response.bind(fixture);
    fixture.response = (payload) => {
      if (record(payload.response, "response").request_id === "bootstrap-permission") {
        fixture.emit({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "bootstrap-use",
                is_error: true,
                content: "SDK MCP server not found: otherside",
              },
            ],
          },
        });
        fixture.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Connection failed",
        });
      } else response(payload);
    };
    await expect(run(fixture.adapter())).rejects.toThrow(
      "Cloud bootstrap SDK callback failed: SDK MCP server not found: otherside",
    );
    expect(fixture.userPosts()).toHaveLength(0);
    expect(fixture.creates).toHaveLength(1);
  });

  it("rejects a second bootstrap RPC without weakening the exactly-once connection gate", async () => {
    const fixture = new CloudFixture();
    const response = fixture.response.bind(fixture);
    fixture.response = (payload) => {
      response(payload);
      if (record(payload.response, "response").request_id === "bootstrap-permission") {
        fixture.rpc(
          "tools/call",
          {
            name: CLOUD_CONNECT_TOOL_NAME,
            arguments: {},
            _meta: { "claudecode/toolUseId": "bootstrap-use" },
          },
          "duplicate-bootstrap-rpc",
          "duplicate-bootstrap-control",
        );
      }
    };
    await expect(run(fixture.adapter())).rejects.toThrow(
      "duplicate connection tools/call callback",
    );
    expect(fixture.userPosts()).toHaveLength(0);
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" &&
          record(post.response, "response").request_id === "duplicate-bootstrap-control",
      ),
    ).toBe(false);
  });

  it("does not post initialization when the SSE handshake fails", async () => {
    const fixture = new CloudFixture();
    fixture.streamStatus = 403;
    await expect(run(fixture.adapter())).rejects.toThrow("403");
    expect(fixture.controls()).toEqual([{ subtype: "interrupt" }]);
    expect(fixture.userPosts()).toHaveLength(0);
    expect(fixture.live.size).toBe(0);
  });

  it("installs hooks, bootstraps session denies, then exposes real schemas and user content", async () => {
    const fixture = new CloudFixture();
    const messages: Message[] = [
      { role: "system", content: [{ type: "text", text: "PRIVATE SYSTEM CONTEXT" }] },
      USER,
    ];
    const events = await run(fixture.adapter(), messages);
    expect(events.filter((event) => event.kind === "text_delta")).toEqual([
      { kind: "text_delta", text: "42" },
    ]);
    expect(events.some((event) => event.kind === "tool_call_complete")).toBe(false);
    expect(events.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
    expect(usage(events)).toMatchObject({ inputTokens: 19, outputTokens: 5 });
    expect(fixture.controls().map((request) => request.subtype)).toEqual([
      "initialize",
      "apply_flag_settings",
      "get_settings",
      "set_max_thinking_tokens",
      "mcp_set_servers",
      "initialize",
      "list_permission_rules",
      "mcp_message",
    ]);
    expect(fixture.controls()[0]).toMatchObject({
      hooks: { PreToolUse: [{ hookCallbackIds: [CLOUD_BOUNDARY_HOOK_ID] }] },
      systemPrompt: ["PRIVATE SYSTEM CONTEXT", expect.any(String)],
    });
    expect(fixture.controls()[5]).toEqual({ subtype: "initialize" });
    expect(fixture.controls()[1]).toEqual({
      subtype: "apply_flag_settings",
      settings: { env: { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0" } },
    });
    const verification = fixture.posts.findIndex(
      (post) =>
        post.type === "control_request" &&
        record(post.request, "request").subtype === "list_permission_rules",
    );
    const before = JSON.stringify(fixture.posts.slice(0, verification));
    expect(record(fixture.userPosts()[0]?.message, "user message").content).toEqual(USER.content);
    const bootstrap = fixture.posts.find((post) => post.type === "user");
    expect(JSON.stringify(bootstrap)).not.toContain("PRIVATE SYSTEM CONTEXT");
    expect(before).not.toContain("17+25");
    expect(before).not.toContain("Local arithmetic");
    expect(responseFor(fixture, "bootstrap-list-control")).toMatchObject({
      mcp_response: { result: { tools: [CLOUD_CONNECT_TOOL] } },
    });
    expect(responseFor(fixture, "bootstrap-permission")).toEqual({
      behavior: "allow",
      updatedInput: {},
      updatedPermissions: [
        {
          type: "addRules",
          destination: "session",
          behavior: "deny",
          rules: NATIVE_TOOLS.map((toolName) => ({ toolName })),
        },
      ],
    });
    expect(responseFor(fixture, "updated-list-1")).toMatchObject({
      mcp_response: {
        result: {
          tools: [
            { name: TOOL.name, description: TOOL.description, inputSchema: TOOL.input_schema },
          ],
        },
      },
    });
    expect(fixture.creates[0]).toMatchObject({
      environment_id: "env_mock",
      config: { sources: [], outcomes: [], model: "claude-opus-5-5", effort_level: "medium" },
      events: [],
    });
    expect(fixture.userPosts()).toHaveLength(1);
  });

  it("waits after list_changed ACK for tools/list, its response and the winning own echo before posting user data", async () => {
    const fixture = new CloudFixture();
    const notified = Promise.withResolvers<void>();
    const responding = Promise.withResolvers<void>();
    const response = Promise.withResolvers<void>();
    const echo = holdResponseEcho(fixture, "updated-list-1");
    fixture.onToolListChanged = () => notified.resolve();
    fixture.beforeResponse = (payload) => {
      if (record(payload.response, "response").request_id !== "updated-list-1") return;
      responding.resolve();
      return response.promise;
    };
    const caller = new AbortController();
    const running = run(fixture.adapter(), [USER], caller.signal);
    try {
      await notified.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fixture.userPosts()).toHaveLength(0);
      fixture.rpc("tools/list", {}, "updated-1", "updated-list-1");
      await responding.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fixture.userPosts()).toHaveLength(0);
      response.resolve();
      await echo.posted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fixture.userPosts()).toHaveLength(0);
      expect(responseFor(fixture, "updated-list-1")).toMatchObject({
        mcp_response: { result: { tools: [{ name: TOOL.name }] } },
      });
      echo.release();
      expect((await running).at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
      expect(fixture.userPosts()).toHaveLength(1);
      const events = fixture.current.events;
      const echoed = events.findIndex(
        (event) =>
          event.source === "client" &&
          event.payload.type === "control_response" &&
          record(event.payload.response, "response").request_id === "updated-list-1",
      );
      expect(echoed).toBeGreaterThanOrEqual(0);
      expect(events.findIndex((event) => event.payload === fixture.userPosts()[0])).toBeGreaterThan(
        echoed,
      );
    } finally {
      response.resolve();
      echo.release();
      caller.abort();
      await running.catch(() => undefined);
    }
  });

  it("times out specifically when list_changed is acknowledged but the worker never requests tools/list", async () => {
    const fixture = new CloudFixture();
    fixture.onToolListChanged = () => {};
    const adapter = fixture.adapter({ controlTimeoutMs: 50 });
    const error = await rejection(run(adapter));
    expect(error).toMatchObject({
      name: "CloudSessionInterruptedError",
      cause: expect.objectContaining({
        name: "TimeoutError",
        message: "Cloud worker did not refresh its local tool list",
        cause: expect.any(Error),
      }),
    });
    expect(adapter.recoverableError(error, CONTEXT).kind).toBe("fail");
    expect(fixture.userPosts()).toHaveLength(0);
    expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
    expect(fixture.live.size).toBe(0);
    const requests = fixture.requests.length;
    expect(await rejection(run(adapter))).toBe(error);
    expect(fixture.requests).toHaveLength(requests);
  });

  it("denies native ToolSearch during literal bootstrap, checks its error result and continues locally", async () => {
    const fixture = new CloudFixture();
    fixture.bootstrapNativeAttempt = true;
    const events = await run(fixture.adapter());
    expect(responseFor(fixture, "bootstrap-native-hook")).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
    expect(events.filter((event) => event.kind === "text_delta")).toEqual([
      { kind: "text_delta", text: "42" },
    ]);
    expect(events.some((event) => event.kind === "tool_call_complete")).toBe(false);
    expect(usage(events)).toMatchObject({ inputTokens: 21, outputTokens: 6 });
    expect(fixture.userPosts()).toHaveLength(1);
  });

  for (const nativeResult of [false, undefined]) {
    it(`does not release user content after an unconfirmed native bootstrap denial (${nativeResult})`, async () => {
      const fixture = new CloudFixture();
      fixture.bootstrapNativeAttempt = true;
      fixture.bootstrapNativeResult = nativeResult;
      await expect(run(fixture.adapter())).rejects.toThrow("denial");
      expect(fixture.userPosts()).toHaveLength(0);
    });
  }

  it("retains native inventory entries while proving effective session rules and Task canonicalization", async () => {
    const fixture = new CloudFixture();
    const events = await run(fixture.adapter());
    expect(
      fixture.current.events.some(
        (event) =>
          event.payload.type === "system" &&
          Array.isArray(event.payload.tools) &&
          event.payload.tools.includes("Bash"),
      ),
    ).toBe(true);
    expect(fixture.rules).toContainEqual({ source: "session", behavior: "deny", rule: "Agent" });
    expect(events.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
  });

  for (const mode of ["missing", "scoped", "notInEffect", "wrongSource", "managedOnly"] as const) {
    it(`fails closed when permission evidence is ${mode}`, async () => {
      const fixture = new CloudFixture();
      fixture.filterRules = (rules) =>
        rules.map((rule) =>
          rule.rule !== "Bash"
            ? rule
            : {
                ...rule,
                ...(mode === "missing" ? { behavior: "allow" } : {}),
                ...(mode === "scoped" ? { rule: "Bash(ls)" } : {}),
                ...(mode === "notInEffect" ? { notInEffect: true } : {}),
                ...(mode === "wrongSource" ? { source: "userSettings" } : {}),
              },
        );
      fixture.managedOnly = mode === "managedOnly";
      const adapter = fixture.adapter();
      await expect(run(adapter)).rejects.toThrow("isolation");
      await expect(run(adapter)).rejects.toThrow("isolation");
      expect(fixture.userPosts()).toHaveLength(0);
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
    });
  }

  it("does not bootstrap if hook installation is missing", async () => {
    const fixture = new CloudFixture();
    fixture.hooksApplied = false;
    await expect(run(fixture.adapter())).rejects.toThrow("PreToolUse hook");
    expect(fixture.posts.some((post) => post.type === "user")).toBe(false);
  });

  it("rejects an unknown worker identity before bootstrap", async () => {
    const fixture = new CloudFixture();
    fixture.pid = undefined;
    await expect(run(fixture.adapter())).rejects.toThrow("worker pid");
    expect(fixture.posts.some((post) => post.type === "user")).toBe(false);
  });

  it("fails closed without inventory before the permission callback", async () => {
    const fixture = new CloudFixture();
    fixture.includeInventory = false;
    await expect(run(fixture.adapter())).rejects.toThrow("inventory");
    expect(responseFor(fixture, "bootstrap-permission")).toMatchObject({ behavior: "deny" });
    expect(fixture.userPosts()).toHaveLength(0);
  });

  it("fails closed when bootstrap succeeds without the required callback", async () => {
    const fixture = new CloudFixture();
    fixture.missingBootstrapCallback = true;
    await expect(run(fixture.adapter())).rejects.toThrow("exactly one");
    expect(fixture.userPosts()).toHaveLength(0);
  });

  it("preserves bootstrap AUP refusal without replacing the session", async () => {
    const fixture = new CloudFixture();
    fixture.bootstrapError = "AUP refusal [cyber]";
    const adapter = fixture.adapter();
    await expect(run(adapter)).rejects.toThrow("AUP refusal [cyber]");
    adapter.onCompactionSucceeded(CONTEXT);
    await expect(run(adapter)).rejects.toThrow("AUP refusal [cyber]");
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.userPosts()).toHaveLength(0);
  });

  it("does not confuse POST receipts with SDK control success", async () => {
    const fixture = new CloudFixture();
    fixture.failControl = "list_permission_rules";
    await expect(run(fixture.adapter())).rejects.toThrow("Control rejected");
    expect(fixture.userPosts()).toHaveLength(0);
  });

  it("preserves SDK initialize/list/call IDs and returns control to the local harness", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    const first = await run(adapter);
    expect(responseFor(fixture, "init-control")).toEqual({
      mcp_response: {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "otherside", version: "1.0.0" },
        },
      },
    });
    expect(responseFor(fixture, "initialized-control")).toEqual({
      mcp_response: { jsonrpc: "2.0", id: 0, result: {} },
    });
    expect(responseFor(fixture, "permission-control")).toEqual({
      behavior: "allow",
      updatedInput: { expression: "17+25" },
    });
    expect(first.filter((event) => event.kind.startsWith("tool_call"))).toEqual([
      { kind: "tool_call_start", id: "tool-use-42", name: "Calculate" },
      { kind: "tool_call_input_delta", id: "tool-use-42", partial: '{"expression":"17+25"}' },
      {
        kind: "tool_call_complete",
        id: "tool-use-42",
        name: "Calculate",
        input: { expression: "17+25" },
      },
    ]);
    expect(first.at(-1)).toEqual({ kind: "message_stop", stop_reason: "tool_calls" });
    expect(fixture.controls().some((request) => request.subtype === "interrupt")).toBe(false);
    expect(usage(first)).toMatchObject({ inputTokens: 17, outputTokens: 8 });
    const second = await run(adapter, [USER, RESULT]);
    expect(responseFor(fixture, "call-control")).toEqual({
      mcp_response: {
        jsonrpc: "2.0",
        id: "rpc-42",
        result: { content: [{ type: "text", text: "42" }], isError: false },
      },
    });
    expect(usage(second)).toMatchObject({ inputTokens: 12, outputTokens: 2 });
    expect(fixture.userPosts()).toHaveLength(1);
    expect(fixture.permissionListings).toBe(2);
  });

  it("keeps local permission rejection and images in SDK results", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "cGl4ZWw=" },
    } as const;
    const message: Message = { role: "user", content: [{ type: "text", text: "inspect" }, image] };
    await run(adapter, [message]);
    expect(record(fixture.userPosts()[0]?.message, "message").content).toEqual(message.content);
    await run(adapter, [
      message,
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-use-42",
            is_error: true,
            content: [{ type: "text", text: "Local permission denied" }, image],
          },
        ],
      },
    ]);
    expect(responseFor(fixture, "call-control")).toMatchObject({
      mcp_response: {
        result: {
          isError: true,
          content: [
            { type: "text", text: "Local permission denied" },
            { type: "image", data: "cGl4ZWw=", mimeType: "image/png" },
          ],
        },
      },
    });
    expect(responseFor(fixture, "permission-control")).not.toHaveProperty("updatedPermissions");
  });

  it("treats bare Bash RPC as local only inside the registered SDK server", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool("Bash");
    const events = await run(fixture.adapter(), [USER], undefined, CONTEXT, [
      { ...TOOL, name: "Bash" },
    ]);
    expect(events).toContainEqual({
      kind: "tool_call_complete",
      id: "tool-use-42",
      name: "Bash",
      input: { expression: "17+25" },
    });
  });

  for (const localName of ["ToolSearch", "Write"]) {
    it(`recovers a denied native ToolSearch through local SDK ${localName} without native dispatch`, async () => {
      const fixture = new CloudFixture();
      fixture.onUser = () => {
        fixture.nativeIntent("ToolSearch");
        // Effective session rules may reject before either permission callback or PreToolUse.
        fixture.nativeResult("native-use", true);
        fixture.callTool(localName);
      };
      const adapter = fixture.adapter();
      const tools = [{ ...TOOL, name: localName }];
      const events = await run(adapter, [USER], undefined, CONTEXT, tools);
      expect(events.filter((event) => event.kind === "tool_call_complete")).toEqual([
        {
          kind: "tool_call_complete",
          id: "tool-use-42",
          name: localName,
          input: { expression: "17+25" },
        },
      ]);
      expect(events.some((event) => "id" in event && event.id === "native-use")).toBe(false);
      expect(
        events.some(
          (event) => event.kind === "text_delta" && event.text.includes("Native permission"),
        ),
      ).toBe(false);
      expect(events.at(-1)).toEqual({ kind: "message_stop", stop_reason: "tool_calls" });
      expect(usage(events)).toMatchObject({ inputTokens: 21, outputTokens: 10 });
      const final = await run(adapter, [USER, RESULT], undefined, CONTEXT, tools);
      expect(final.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
      expect(fixture.lifecycle).not.toContain("interrupt");
      expect(fixture.creates).toHaveLength(1);
    });
  }

  it("denies stale Connect hooks and permissions after ready, then continues only after its error result", async () => {
    const fixture = new CloudFixture();
    const name = `${MCP_TOOL_PREFIX}${CLOUD_CONNECT_TOOL_NAME}`;
    fixture.onUser = () => {
      fixture.nativeIntent(name, "stale-connect-use");
      fixture.hook("stale-connect-hook", name);
      fixture.emit({
        type: "control_request",
        request_id: "stale-connect-permission",
        request: {
          subtype: "can_use_tool",
          tool_name: name,
          tool_use_id: "stale-connect-use",
          input: {},
        },
      });
      fixture.nativeResult("stale-connect-use", true);
      fixture.callTool();
    };
    const adapter = fixture.adapter();
    const events = await run(adapter);
    expect(responseFor(fixture, "stale-connect-hook")).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(responseFor(fixture, "stale-connect-permission")).toEqual({
      behavior: "deny",
      message: "Only registered Otherside SDK tools are permitted",
    });
    expect(events.filter((event) => event.kind === "tool_call_complete")).toEqual([
      {
        kind: "tool_call_complete",
        id: "tool-use-42",
        name: TOOL.name,
        input: { expression: "17+25" },
      },
    ]);
    expect((await run(adapter, [USER, RESULT])).at(-1)).toEqual({
      kind: "message_stop",
      stop_reason: "stop",
    });
    expect(fixture.lifecycle).not.toContain("interrupt");
  });

  for (const outcome of ["missing", "success", "unspecified"] as const) {
    it(`keeps a stale Connect ${outcome} denial result terminal after ready`, async () => {
      const fixture = new CloudFixture();
      const name = `${MCP_TOOL_PREFIX}${CLOUD_CONNECT_TOOL_NAME}`;
      fixture.onUser = () => {
        fixture.nativeIntent(name, "stale-connect-use");
        fixture.hook("stale-connect-hook", name);
        if (outcome !== "missing")
          fixture.nativeResult("stale-connect-use", outcome === "success" ? false : undefined);
        fixture.finish();
      };
      const adapter = fixture.adapter();
      const message =
        outcome === "missing"
          ? "without confirming all native tool denial results"
          : "without confirmed denial";
      await expect(run(adapter)).rejects.toThrow(message);
      await expect(run(adapter, [USER, USER])).rejects.toThrow(message);
      expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
      expect(fixture.creates).toHaveLength(1);
    });
  }

  for (const name of [CLOUD_CONNECT_TOOL_NAME, `${MCP_TOOL_PREFIX}${CLOUD_CONNECT_TOOL_NAME}`]) {
    it(`never dispatches the removed Connect tools/call ${name} after ready`, async () => {
      const fixture = new CloudFixture();
      fixture.onUser = () =>
        fixture.rpc(
          "tools/call",
          { name, arguments: {}, _meta: { "claudecode/toolUseId": "stale-connect-use" } },
          "stale-connect-rpc",
          "stale-connect-control",
        );
      await expect(run(fixture.adapter())).rejects.toThrow("unregistered local tool");
      expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
      expect(
        fixture.posts.some(
          (post) =>
            post.type === "control_response" &&
            record(post.response, "response").request_id === "stale-connect-control",
        ),
      ).toBe(false);
    });
  }

  for (const name of [
    CLOUD_CONNECT_TOOL_NAME,
    `${MCP_TOOL_PREFIX}${CLOUD_CONNECT_TOOL_NAME}Unknown`,
  ]) {
    it(`does not extend the stale Connect exception to unknown intent ${name}`, async () => {
      const fixture = new CloudFixture();
      fixture.onUser = () => {
        fixture.nativeIntent(name);
        fixture.nativeResult("native-use", true);
        fixture.finish();
      };
      await expect(run(fixture.adapter())).rejects.toThrow("nonlocal tool");
      expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
    });
  }

  for (const isError of [false, undefined]) {
    it(`interrupts a protected native result without is_error true (${isError})`, async () => {
      const fixture = new CloudFixture();
      fixture.onUser = () => {
        fixture.nativeIntent("ToolSearch");
        fixture.nativeResult("native-use", isError);
        fixture.callTool("Write");
      };
      const observed: ProviderEvent[] = [];
      const adapter = fixture.adapter();
      const source = adapter.translateResponse(
        adapter.stream(
          CONTEXT,
          adapter.translateRequest(CONTEXT, [USER], [{ ...TOOL, name: "Write" }]),
          new AbortController().signal,
        ),
      );
      await expect(
        (async () => {
          for await (const event of source) observed.push(event);
        })(),
      ).rejects.toThrow("without confirmed denial");
      expect(observed.some((event) => event.kind.startsWith("tool_call"))).toBe(false);
      expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
    });
  }

  it("interrupts a completed turn with any native denial result still missing", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => {
      fixture.nativeIntent("ToolSearch", "first-native");
      fixture.nativeIntent("ToolSearch", "second-native");
      fixture.nativeResult("first-native", true);
      fixture.finish();
    };
    const adapter = fixture.adapter();
    await expect(run(adapter)).rejects.toThrow("without confirming all native tool denial results");
    await expect(run(adapter)).rejects.toThrow("without confirming all native tool denial results");
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
  });

  it("does not accept a client echo as evidence of native denial", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => {
      fixture.nativeIntent("ToolSearch");
      fixture.nativeResult("native-use", true, "client");
      fixture.finish();
    };
    await expect(run(fixture.adapter())).rejects.toThrow(
      "without confirming all native tool denial results",
    );
    expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
  });

  it("uses the same Task/Agent normalization for native protection and denial rules", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => {
      fixture.emit({
        type: "system",
        subtype: "init",
        tools: ["Bash", "Read", "Agent", "ToolSearch", `${MCP_TOOL_PREFIX}Calculate`],
      });
      fixture.nativeIntent("Agent");
      fixture.hook("agent-native-hook", "Agent");
      fixture.nativeResult("native-use", true);
      fixture.finish();
    };
    const events = await run(fixture.adapter());
    expect(responseFor(fixture, "agent-native-hook")).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(events.some((event) => event.kind.startsWith("tool_call"))).toBe(false);
    expect(events.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
    expect(fixture.lifecycle).not.toContain("interrupt");
  });

  it("does not recover a known native intent before boundary revalidation finishes", async () => {
    const fixture = new CloudFixture();
    const control = fixture.control.bind(fixture);
    fixture.control = (payload) => {
      const request = record(payload.request, "request");
      if (request.subtype === "initialize" && !request.hooks) fixture.nativeIntent("ToolSearch");
      control(payload);
    };
    await expect(run(fixture.adapter())).rejects.toThrow("nonlocal tool");
    expect(fixture.userPosts()).toHaveLength(0);
    expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
  });

  it("retains native denial confirmation across a local tool round and control revalidation", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => {
      fixture.nativeIntent("ToolSearch");
      fixture.callTool();
    };
    const adapter = fixture.adapter();
    const first = await run(adapter);
    expect(first.at(-1)).toEqual({ kind: "message_stop", stop_reason: "tool_calls" });
    // The worker's result arrives while the local tool runs and must be consumed on reopening.
    fixture.nativeResult("native-use", true);
    const final = await run(adapter, [USER, RESULT]);
    expect(final.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
    expect(fixture.lifecycle).not.toContain("interrupt");
    expect(fixture.permissionListings).toBe(2);
  });

  it("hints only the exact registered local replacement while continuing to deny natively", async () => {
    const fixture = new CloudFixture();
    fixture.bootstrapNativeAttempt = true;
    fixture.onUser = () => {
      fixture.nativeIntent("ToolSearch");
      fixture.hook("native-search-hook", "ToolSearch");
      fixture.emit({
        type: "control_request",
        request_id: "native-search-permission",
        request: {
          subtype: "can_use_tool",
          tool_name: "ToolSearch",
          tool_use_id: "native-use",
          input: {},
        },
      });
      fixture.nativeResult("native-use", true);
      fixture.callTool("ToolSearch");
    };
    const events = await run(fixture.adapter(), [USER], undefined, CONTEXT, [
      { ...TOOL, name: "ToolSearch" },
    ]);
    expect(responseFor(fixture, "bootstrap-native-hook")).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: "Only registered local Otherside SDK callbacks are permitted.",
      },
    });
    expect(responseFor(fixture, "native-search-hook")).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("Use mcp__otherside__ToolSearch instead"),
      },
    });
    expect(responseFor(fixture, "native-search-permission")).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("Use mcp__otherside__ToolSearch instead"),
    });
    expect(events.filter((event) => event.kind === "tool_call_complete")).toHaveLength(1);
    expect(fixture.lifecycle).not.toContain("interrupt");
  });

  it("does not invent a local replacement from a similar registered name", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => {
      fixture.nativeIntent("ToolSearch");
      fixture.hook("native-search-hook", "ToolSearch");
      fixture.nativeResult("native-use", true);
      fixture.finish();
    };
    await run(fixture.adapter(), [USER], undefined, CONTEXT, [{ ...TOOL, name: "toolsearch" }]);
    expect(responseFor(fixture, "native-search-hook")).toMatchObject({
      hookSpecificOutput: {
        permissionDecisionReason: "Only registered local Otherside SDK callbacks are permitted.",
      },
    });
  });

  it("denies bare native Bash but recovers through the registered SDK Bash", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => {
      fixture.nativeIntent("Bash");
      fixture.hook("remote-hook", "Bash");
      fixture.nativeResult("native-use", true);
      fixture.callTool("Bash");
    };
    const events = await run(fixture.adapter(), [USER], undefined, CONTEXT, [
      { ...TOOL, name: "Bash" },
    ]);
    expect(responseFor(fixture, "remote-hook")).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
    expect(events.filter((event) => event.kind === "tool_call_complete")).toEqual([
      {
        kind: "tool_call_complete",
        id: "tool-use-42",
        name: "Bash",
        input: { expression: "17+25" },
      },
    ]);
    expect(fixture.lifecycle).not.toContain("interrupt");
  });

  it("denies native can_use_tool and ignores remote rule suggestions", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => {
      fixture.nativeIntent("Bash");
      fixture.emit({
        type: "control_request",
        request_id: "native-permission",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          tool_use_id: "native-use",
          input: {},
          permission_suggestions: [{ behavior: "allow" }],
        },
      });
      fixture.nativeResult("native-use", true);
      fixture.finish();
    };
    const events = await run(fixture.adapter());
    expect(events.some((event) => event.kind.startsWith("tool_call"))).toBe(false);
    expect(events.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
    expect(fixture.lifecycle).not.toContain("interrupt");
    expect(responseFor(fixture, "native-permission")).toEqual({
      behavior: "deny",
      message: "Only registered Otherside SDK tools are permitted",
    });
  });

  it("interrupts unprotected native assistant intent without replaying past the violation", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.nativeIntent("UnknownRemoteTool");
    const adapter = fixture.adapter();
    await expect(run(adapter)).rejects.toThrow("nonlocal tool");
    await expect(run(adapter)).rejects.toThrow("nonlocal tool");
    expect(fixture.userPosts()).toHaveLength(1);
    expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
  });

  it("revalidates PID and rules for multiple turns without replay or bootstrap usage duplication", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    await run(adapter);
    const second = await run(adapter, [
      USER,
      ASSISTANT,
      { role: "user", content: [{ type: "text", text: "next" }] },
    ]);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.permissionListings).toBe(2);
    expect(fixture.userPosts()).toHaveLength(2);
    expect(record(fixture.userPosts()[1]?.message, "message").content).toEqual([
      { type: "text", text: "next" },
    ]);
    expect(usage(second)).toMatchObject({ inputTokens: 12, outputTokens: 2 });
    expect(
      fixture
        .controls()
        .filter((request) => request.subtype === "initialize")
        .slice(1),
    ).toEqual([{ subtype: "initialize" }, { subtype: "initialize" }]);
  });

  it("cold-resumes an idle recycled worker only for a new user turn with complete context", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    await run(adapter);
    const next: Message = {
      role: "user",
      content: [{ type: "text", text: "New request after idle recycle" }],
    };
    const stale = adapter.translateRequest(CONTEXT, [USER, ASSISTANT, next], [TOOL]);
    const before = fixture.requests.length;
    fixture.pid = 42;
    fixture.rules = []; // The replacement process has no session rules: never reuse it for inference.
    const events = await run(adapter, [USER, ASSISTANT, next]);
    expect(events.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toEqual(["cse_mock1"]);
    expect(fixture.userPosts().map((post) => post.session_id)).toEqual(["cse_mock1", "cse_mock2"]);
    expect(record(fixture.userPosts()[1]?.message, "replacement snapshot").content).toEqual(
      expectedSnapshot([USER, ASSISTANT], next.content),
    );
    const oldControls = fixture.requests
      .slice(before)
      .filter(
        ({ url, init }) =>
          url.pathname === "/v1/code/sessions/cse_mock1/events" && init.method === "POST",
      )
      .map(({ init }) => {
        const body = record(JSON.parse(String(init.body)), "post body");
        if (!Array.isArray(body.events)) throw new Error("Missing post events");
        const payload = record(record(body.events[0], "event").payload, "payload");
        return record(payload.request, "request");
      });
    expect(oldControls).toEqual([{ subtype: "initialize" }, { subtype: "interrupt" }]);
    expect(
      fixture.controls().filter((request) => request.subtype === "initialize" && request.hooks),
    ).toHaveLength(2);
    await expect(
      collect(adapter.stream(CONTEXT, stale, new AbortController().signal)),
    ).rejects.toThrow("predates compaction");
    await run(adapter, [USER, ASSISTANT, next, ASSISTANT, USER]);
    expect(fixture.creates).toHaveLength(2);
    expect(record(fixture.userPosts()[2]?.message, "incremental").content).toEqual(USER.content);
  });

  for (const messages of [
    [USER],
    [USER, ASSISTANT],
    [
      USER,
      ASSISTANT,
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "[Request interrupted by user]" }],
      },
    ],
  ]) {
    it(`does not recycle an idle PID for a retry or non-user continuation (${messages.length} records)`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter();
      await run(adapter);
      fixture.pid = 42;
      await expect(run(adapter, messages)).rejects.toThrow("identity changed");
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.archives).toHaveLength(0);
      expect(fixture.userPosts()).toHaveLength(1);
    });
  }

  it("detaches a PID change with a pending local SDK result without delivering it", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    fixture.pid = 42;
    await expect(run(adapter, [USER, RESULT])).rejects.toThrow("identity changed");
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" &&
          record(post.response, "response").request_id === "call-control",
      ),
    ).toBe(false);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  it("detaches PID changes during bootstrap verification before submitting user data", async () => {
    const fixture = new CloudFixture();
    const control = fixture.control.bind(fixture);
    fixture.control = (payload) => {
      const request = record(payload.request, "request");
      if (request.subtype === "initialize" && !request.hooks) fixture.pid = 42;
      control(payload);
    };
    await expect(run(fixture.adapter())).rejects.toThrow("identity changed");
    expect(fixture.userPosts()).toHaveLength(0);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  it("does not recycle when protection disappears but the PID is unchanged", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    await run(adapter);
    fixture.rules = [];
    await expect(run(adapter, [USER, ASSISTANT, USER])).rejects.toThrow("session denies");
    expect(fixture.userPosts()).toHaveLength(1);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  it("rejects an idle PID replacement when the bound account changed", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    await run(adapter);
    fixture.pid = 42;
    fixture.tokens = { ...fixture.tokens, accountUuid: "other-account" };
    const before = fixture.requests.length;
    await expect(run(adapter, [USER, ASSISTANT, USER])).rejects.toThrow("identity changed");
    expect(fixture.requests).toHaveLength(before);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  for (const phase of ["catch-up", "shutdown"] as const) {
    it(`keeps terminal diagnostics from ${phase} ahead of idle PID recovery`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter();
      await run(adapter);
      fixture.pid = 42;
      const terminal = {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["AUP failure around worker recycle"],
      };
      if (phase === "catch-up") fixture.emit(terminal);
      else
        fixture.interruptEvents = (payload) => {
          fixture.emit(terminal);
          fixture.emit({
            type: "control_response",
            response: { subtype: "success", request_id: payload.request_id },
          });
        };
      await expect(run(adapter, [USER, ASSISTANT, USER])).rejects.toThrow(
        "AUP failure around worker recycle",
      );
      await expect(run(adapter, [USER, ASSISTANT, USER])).rejects.toThrow(
        "AUP failure around worker recycle",
      );
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.archives).toHaveLength(0);
      expect(fixture.userPosts()).toHaveLength(1);
    });
  }

  it("does not recycle an idle worker that has unexpected inference queued in catch-up", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    await run(adapter);
    fixture.pid = 42;
    fixture.assistant(
      "unexpected-after-result",
      [{ type: "text", text: "Unexpected continuation" }],
      {},
    );
    await expect(run(adapter, [USER, ASSISTANT, USER])).rejects.toThrow("identity changed");
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  it("does not release a pending local result when session denies disappeared", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    await run(adapter);
    fixture.rules = [];
    await expect(run(adapter, [USER, RESULT])).rejects.toThrow("session denies");
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" &&
          record(post.response, "response").request_id === "call-control",
      ),
    ).toBe(false);
  });

  it("fails closed on active-reader reconnect rather than silently trusting a new worker", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => {
      for (const output of fixture.live) output.close();
      fixture.live.clear();
      fixture.finish();
    };
    await expect(run(fixture.adapter())).rejects.toThrow("protection cannot be revalidated");
    expect(fixture.userPosts()).toHaveLength(1);
    expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
  });

  it("sends explicit hook deny before interrupt/reader close when cancellation races a callback", async () => {
    const fixture = new CloudFixture();
    const abort = new AbortController();
    fixture.onUser = () => fixture.hook("cancelled-hook", `${MCP_TOOL_PREFIX}Calculate`);
    fixture.beforeResponse = (payload) => {
      const response = record(payload.response, "response");
      const body = record(response.response, "body");
      if (response.request_id === "cancelled-hook" && !body.hookSpecificOutput)
        abort.abort(new DOMException("Cancelled locally", "AbortError"));
    };
    await expect(run(fixture.adapter(), [USER], abort.signal)).rejects.toThrow("Cancelled locally");
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" && record(post.response, "response").subtype === "error",
      ),
    ).toBe(false);
    expect(fixture.lifecycle.indexOf("hook-deny")).toBeLessThan(
      fixture.lifecycle.indexOf("interrupt"),
    );
    expect(fixture.lifecycle.indexOf("interrupt")).toBeLessThan(
      fixture.lifecycle.lastIndexOf("reader-close"),
    );
    expect(fixture.live.size).toBe(0);
  });

  it("interrupts a bootstrap timeout without releasing user data", async () => {
    const fixture = new CloudFixture();
    fixture.bootstrap = () => undefined;
    await expect(run(fixture.adapter({ bootstrapTimeoutMs: 10 }))).rejects.toThrow();
    expect(fixture.userPosts()).toHaveLength(0);
    expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
    expect(fixture.live.size).toBe(0);
  });

  it("identifies initialize as the deadline phase while preserving TimeoutError and its cause", async () => {
    const fixture = new CloudFixture();
    fixture.silentControl = "initialize";
    const adapter = fixture.adapter({ controlTimeoutMs: 10 });
    const error = await rejection(run(adapter));
    expect(error).toMatchObject({
      name: "CloudSessionInterruptedError",
      cause: expect.objectContaining({
        name: "TimeoutError",
        message: "Cloud initialize timed out",
        cause: expect.objectContaining({ name: "TimeoutError" }),
      }),
    });
    expect(adapter.recoverableError(error, CONTEXT)).toMatchObject({ kind: "fail" });
    expect(fixture.posts.some((post) => post.type === "user")).toBe(false);
    expect(fixture.live.size).toBe(0);
  });

  it("closes a stalled control after its deadline", async () => {
    const fixture = new CloudFixture();
    fixture.silentControl = "list_permission_rules";
    await expect(run(fixture.adapter({ controlTimeoutMs: 10 }))).rejects.toThrow();
    expect(fixture.userPosts()).toHaveLength(0);
    expect(fixture.live.size).toBe(0);
  });

  it("keeps cumulative billing at 200k while context tracks the last 50k inference across callbacks/results", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    fixture.onUser = () => {
      fixture.assistant("earlier-inference", [{ type: "text", text: "Earlier analysis" }], {
        input_tokens: 100_000,
        output_tokens: 10_000,
        cache_creation_input_tokens: 20_000,
        cache_read_input_tokens: 19_990,
      });
      fixture.assistant(
        "latest-inference",
        [
          {
            type: "tool_use",
            id: "tool-use-42",
            name: `${MCP_TOOL_PREFIX}Calculate`,
            input: { expression: "17+25" },
          },
        ],
        {
          input_tokens: 30_000,
          output_tokens: 5_000,
          cache_creation_input_tokens: 5_000,
          cache_read_input_tokens: 10_000,
        },
      );
      fixture.rpc(
        "tools/call",
        {
          name: "Calculate",
          arguments: { expression: "17+25" },
          _meta: { "claudecode/toolUseId": "tool-use-42" },
        },
        "rpc-42",
        "call-control",
      );
    };
    fixture.onToolResult = () =>
      fixture.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "42",
        usage: { input_tokens: 999_000, output_tokens: 99_000 },
      });
    const first = await run(adapter);
    const counters = usage(first);
    expect(counters).toEqual({
      kind: "usage",
      inputTokens: 130_007,
      outputTokens: 15_003,
      cacheCreationInputTokens: 25_000,
      cacheReadInputTokens: 29_990,
      contextTokens: 50_000,
    });
    if (!counters) throw new Error("Missing billed usage");
    expect(
      (counters.inputTokens ?? 0) +
        (counters.outputTokens ?? 0) +
        (counters.cacheCreationInputTokens ?? 0) +
        (counters.cacheReadInputTokens ?? 0),
    ).toBe(200_000);
    expect(
      first.filter((event) => event.kind === "usage").map((event) => event.contextTokens),
    ).toEqual([149_990, 50_000, 50_000]);
    const result = await run(adapter, [USER, RESULT]);
    expect(usage(result)).toEqual({
      kind: "usage",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      contextTokens: 50_000,
    });
    fixture.onUser = () => {
      fixture.assistant("next-turn", [{ type: "text", text: "New answer" }], {
        input_tokens: 2_000,
        output_tokens: 500,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 400,
      });
      fixture.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        usage: { input_tokens: 900_000 },
      });
    };
    const next = await run(adapter, [
      USER,
      RESULT,
      ASSISTANT,
      { role: "user", content: [{ type: "text", text: "Next user task" }] },
    ]);
    expect(usage(next)).toEqual({
      kind: "usage",
      inputTokens: 2_000,
      outputTokens: 500,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 400,
      contextTokens: 3_000,
    });
    expect(JSON.stringify(fixture.posts)).not.toContain("contextTokens");
  });

  it("preserves a zero context snapshot rather than omitting it", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => {
      fixture.assistant("zero-context", [], {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
      fixture.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        usage: { input_tokens: 123_000, output_tokens: 45_000 },
      });
    };
    const events = await run(fixture.adapter());
    expect(usage(events)).toMatchObject({ contextTokens: 0, inputTokens: 7, outputTokens: 3 });
  });

  for (const messages of [[USER], [USER, ASSISTANT, USER]]) {
    it(`never infers context from a result total or bootstrap context (${messages.length} records)`, async () => {
      const fixture = new CloudFixture();
      fixture.onUser = () =>
        fixture.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          usage: { input_tokens: 200_000, output_tokens: 10_000 },
          contextTokens: 999_999,
        });
      const events = await run(fixture.adapter(), messages);
      expect(usage(events)).toMatchObject({ inputTokens: 200_007, outputTokens: 10_003 });
      expect(usage(events)).not.toHaveProperty("contextTokens");
    });
  }

  it("clears the previous turn's context when the next response has no inference usage", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    expect(usage(await run(adapter))).toMatchObject({ contextTokens: 14 });
    fixture.onUser = () =>
      fixture.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        usage: { input_tokens: 123_000, output_tokens: 4_000 },
      });
    const events = await run(adapter, [USER, ASSISTANT, USER]);
    expect(usage(events)).toMatchObject({ inputTokens: 123_000, outputTokens: 4_000 });
    expect(usage(events)).not.toHaveProperty("contextTokens");
  });

  for (const invalid of [
    { input_tokens: Number.NaN, output_tokens: 1 },
    { input_tokens: 1, output_tokens: Number.POSITIVE_INFINITY },
    { input_tokens: 1, output_tokens: -1 },
    { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: Number.NaN },
    { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: Number.NEGATIVE_INFINITY },
    { input_tokens: Number.MAX_VALUE, output_tokens: Number.MAX_VALUE },
    { input_tokens: 1 },
    {},
  ]) {
    it(`invalidates an incomplete raw context snapshot (${JSON.stringify(invalid)}) without changing billing rules`, async () => {
      const fixture = new CloudFixture();
      fixture.onUser = () => {
        fixture.assistant("valid-first", [], { input_tokens: 40, output_tokens: 10 });
        fixture.assistant("invalid-last", [], invalid);
        fixture.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          usage: { input_tokens: 999_000, output_tokens: 99_000 },
        });
      };
      const events = await run(fixture.adapter());
      const usages = events.filter((event) => event.kind === "usage");
      expect(usages[0]).toMatchObject({ contextTokens: 50 });
      expect(usages[1]).toHaveProperty("contextTokens", null);
      expect(usages.at(-1)).toHaveProperty("contextTokens", null);
    });
  }

  it("carries a context tombstone through tool handoff and result without changing billed usage", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    fixture.onUser = () => {
      fixture.assistant("confirmed-context", [], { input_tokens: 40_000, output_tokens: 10_000 });
      fixture.emit({
        type: "assistant",
        message: {
          id: "unmeasured-context",
          model: CONTEXT.model,
          content: [
            {
              type: "tool_use",
              id: "tool-use-42",
              name: `${MCP_TOOL_PREFIX}Calculate`,
              input: { expression: "17+25" },
            },
          ],
        },
      });
      fixture.rpc(
        "tools/call",
        {
          name: "Calculate",
          arguments: { expression: "17+25" },
          _meta: { "claudecode/toolUseId": "tool-use-42" },
        },
        "rpc-42",
        "call-control",
      );
    };
    fixture.onToolResult = () =>
      fixture.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        usage: { input_tokens: 500_000 },
      });
    const first = await run(adapter);
    expect(
      first.filter((event) => event.kind === "usage").map((event) => event.contextTokens),
    ).toEqual([50_000, null, null]);
    expect(usage(first)).toMatchObject({
      inputTokens: 40_007,
      outputTokens: 10_003,
      contextTokens: null,
    });
    const second = await run(adapter, [USER, RESULT]);
    expect(usage(second)).toEqual({
      kind: "usage",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      contextTokens: null,
    });
    expect(JSON.stringify(fixture.posts)).not.toContain("contextTokens");
  });

  it("invalidates explicit unusable usage on the same inference but carries that tombstone through partial blocks", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => {
      fixture.assistant("same-inference", [], { input_tokens: 40_000, output_tokens: 10_000 });
      fixture.assistant("same-inference", [], { input_tokens: 40_000, output_tokens: Number.NaN });
      fixture.emit({
        type: "assistant",
        message: { id: "same-inference", model: CONTEXT.model, content: [] },
      });
      fixture.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        usage: { input_tokens: 500_000 },
      });
    };
    const events = await run(fixture.adapter());
    expect(
      events.filter((event) => event.kind === "usage").map((event) => event.contextTokens),
    ).toEqual([50_000, null, null, null]);
  });

  it("retains a snapshot for partial blocks but invalidates it for a new inference without usage", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => {
      fixture.assistant("same-message", [{ type: "text", text: "first" }], {
        input_tokens: 40,
        output_tokens: 10,
      });
      fixture.emit({
        type: "assistant",
        message: {
          id: "same-message",
          model: CONTEXT.model,
          content: [{ type: "text", text: "second" }],
        },
      });
      fixture.emit({
        type: "assistant",
        message: {
          id: "new-message-no-usage",
          model: CONTEXT.model,
          content: [{ type: "text", text: "third" }],
        },
      });
      fixture.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        usage: { input_tokens: 500_000 },
      });
    };
    const events = await run(fixture.adapter());
    expect(
      events.filter((event) => event.kind === "usage").map((event) => event.contextTokens),
    ).toEqual([50, 50, null, null]);
  });

  for (const snapshot of [0, 50_000, null, Number.POSITIVE_INFINITY, -1, "50000", undefined]) {
    it(`validates normalized context metadata at the ProviderEvent boundary (${String(snapshot)})`, async () => {
      const adapter = new CloudFixture().adapter();
      async function* raw() {
        const encoded = encodeCloudEvent({
          event_type: "message",
          payload: {
            type: "result",
            subtype: "success",
            is_error: false,
            usage: { input_tokens: 200_000, output_tokens: 0 },
            contextTokens: snapshot,
          },
        });
        // JSON.stringify(Infinity) would create a legitimate null tombstone; 1e999 tests overflow.
        if (snapshot === Number.POSITIVE_INFINITY) {
          yield new TextEncoder().encode(
            new TextDecoder()
              .decode(encoded)
              .replace('"contextTokens":null', '"contextTokens":1e999'),
          );
        } else yield encoded;
      }
      const counters = usage(await collect(adapter.translateResponse(raw())));
      expect(counters).toMatchObject({ inputTokens: 200_000, outputTokens: 0 });
      if (
        snapshot === null ||
        (typeof snapshot === "number" && Number.isFinite(snapshot) && snapshot >= 0)
      )
        expect(counters).toMatchObject({ contextTokens: snapshot });
      else expect(counters).not.toHaveProperty("contextTokens");
    });
  }

  it("never retries a latched control timeout even when the shared classifier would retry it", async () => {
    const fixture = new CloudFixture();
    fixture.silentControl = "list_permission_rules";
    const adapter = fixture.adapter({ controlTimeoutMs: 10 });
    const error = await rejection(run(adapter));
    expect(error).toBeInstanceOf(CloudSessionInterruptedError);
    if (!(error instanceof CloudSessionInterruptedError))
      throw new Error("Expected interrupted session");
    expect(error.cause).toMatchObject({
      name: "TimeoutError",
      message: "Cloud list_permission_rules timed out",
      cause: expect.objectContaining({ name: "TimeoutError" }),
    });
    expect(
      classifyProviderError(error.cause, { provider: CONTEXT.provider, model: CONTEXT.model }).kind,
    ).toBe("retry");
    const decision = adapter.recoverableError(error, CONTEXT);
    expect(decision.kind).toBe("fail");
    expect(decision).not.toHaveProperty("delayMs");
    const before = fixture.requests.length;
    expect(await rejection(run(adapter))).toBe(error);
    expect(adapter.recoverableError(error, CONTEXT, 9).kind).toBe("fail");
    expect(fixture.requests).toHaveLength(before);
    // The underlying transport error remains retryable in an independent, untouched context.
    expect(adapter.recoverableError(error.cause, { ...CONTEXT, isCompaction: true }).kind).toBe(
      "retry",
    );
    expect(
      classifyProviderError(error.cause, { provider: "anthropic", model: CONTEXT.model }).kind,
    ).toBe("retry");
  });

  it("stops retries while an aborted attempt is still completing shutdown", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const caller = new AbortController();
    const attempt = new AbortController();
    const signal = AbortSignal.any([caller.signal, attempt.signal]);
    const submitted = Promise.withResolvers<void>();
    fixture.onUser = () => submitted.resolve();
    const running = rejection(
      run(adapter, [USER], signal, { ...CONTEXT, abortSignal: caller.signal }),
    );
    await submitted.promise;
    const timeout = new DOMException("Content watchdog timeout", "TimeoutError");
    attempt.abort(timeout);
    // The consumer need not await asynchronous cleanup before asking for the retry decision.
    expect(adapter.recoverableError(timeout, CONTEXT).kind).toBe("fail");
    expect(await running).toMatchObject({ name: "CloudSessionInterruptedError", cause: timeout });
    expect(adapter.recoverableError(timeout, CONTEXT).kind).toBe("fail");
  });

  it("keeps latched AUP and native safety failures terminal in retry decisions", async () => {
    const aup = new CloudFixture();
    aup.onUser = () =>
      aup.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["AUP refusal [cyber]"],
      });
    const aupAdapter = aup.adapter();
    expect(await run(aupAdapter)).toContainEqual({ kind: "error", error: "AUP refusal [cyber]" });
    const unrelatedTimeout = new DOMException("Timeout while retrying", "TimeoutError");
    expect(aupAdapter.recoverableError(unrelatedTimeout, CONTEXT)).toMatchObject({
      kind: "fail",
      reason: expect.stringContaining("AUP refusal"),
    });
    const unsafe = new CloudFixture();
    unsafe.onUser = () => unsafe.nativeIntent("UnprotectedRemoteTool");
    const safetyAdapter = unsafe.adapter();
    const error = await rejection(run(safetyAdapter));
    expect(safetyAdapter.recoverableError(error, CONTEXT)).toMatchObject({
      kind: "fail",
      reason: expect.stringContaining("nonlocal tool"),
    });
    expect(safetyAdapter.recoverableError(unrelatedTimeout, CONTEXT).kind).toBe("fail");
  });

  it("does not retry the cancelled body while allowing a separately submitted new user prompt", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const caller = new AbortController();
    const submitted = Promise.withResolvers<void>();
    fixture.onUser = () => submitted.resolve();
    const running = rejection(
      run(adapter, [USER], caller.signal, { ...CONTEXT, abortSignal: caller.signal }),
    );
    await submitted.promise;
    caller.abort("user-cancel");
    expect(await running).toBe("user-cancel");
    const before = fixture.requests.length;
    const error = await rejection(run(adapter, [USER]));
    expect(String(error)).toContain("new user prompt or local rejection");
    expect(adapter.recoverableError(error, CONTEXT).kind).toBe("fail");
    expect(
      adapter.recoverableError(new DOMException("Timeout while retrying", "TimeoutError"), CONTEXT)
        .kind,
    ).toBe("fail");
    expect(fixture.requests).toHaveLength(before);
    fixture.onUser = () => fixture.finish();
    const events = await run(adapter, [
      USER,
      { role: "user", content: [{ type: "text", text: "A newly requested task" }] },
    ]);
    expect(events.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
    expect(fixture.creates).toHaveLength(2);
  });

  for (const response of [
    {
      status: 429,
      body: { error: { type: "insufficient_quota", message: "Cloud quota exhausted" } },
      quota: true,
    },
    {
      status: 401,
      body: { error: { type: "authentication_error", message: "OAuth login required" } },
      quota: false,
    },
  ]) {
    it(`preserves shared quota/auth classification for latched HTTP ${response.status}`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter({
        fetch: async () => Response.json(response.body, { status: response.status }),
      });
      const error = await rejection(run(adapter));
      const expected = classifyProviderError(error, {
        provider: CONTEXT.provider,
        model: CONTEXT.model,
      });
      expect(expected.kind).toBe("fail");
      const decision = adapter.recoverableError(error, CONTEXT);
      expect(decision).toEqual(expected);
      expect(decision).toMatchObject({ kind: "fail", status: response.status });
      if (response.quota) expect(decision).toMatchObject({ quotaExhausted: true });
      else expect(decision).not.toHaveProperty("quotaExhausted", true);
    });
  }

  it("preserves typed quota metadata when translation is more precise than the latched worker event", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    fixture.onUser = () =>
      fixture.emit({
        type: "error",
        error: { type: "insufficient_quota", message: "Cloud quota exhausted" },
      });
    const error = await rejection(run(adapter));
    expect(error).toBeInstanceOf(CloudSessionInterruptedError);
    expect(adapter.recoverableError(error, CONTEXT)).toMatchObject({
      kind: "fail",
      quotaExhausted: true,
      userMessage: expect.stringContaining("Send a new message"),
    });
    expect(fixture.creates).toHaveLength(1);
  });

  it("retains shared transient-error retries before a Cloud session is latched", () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const timeout = new DOMException("Connection timed out", "TimeoutError");
    expect(adapter.recoverableError(timeout, CONTEXT)).toMatchObject({
      kind: "retry",
      delayMs: expect.any(Number),
    });
    expect(fixture.requests).toHaveLength(0);
  });

  it("preserves AUP user-result errors and refuses automatic session replacement", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () =>
      fixture.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["AUP refusal [cyber]"],
        usage: { input_tokens: 3, output_tokens: 0 },
      });
    const adapter = fixture.adapter();
    expect(await run(adapter)).toContainEqual({ kind: "error", error: "AUP refusal [cyber]" });
    adapter.onCompactionSucceeded(CONTEXT);
    await expect(run(adapter)).rejects.toThrow("AUP refusal [cyber]");
    expect(fixture.creates).toHaveLength(1);
  });

  it("updates dynamic schemas only after revalidating the boundary", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    await run(adapter);
    const added = {
      name: "Inspect",
      description: "Inspect locally",
      inputSchema: { type: "object", properties: {} },
    };
    await run(adapter, [USER, ASSISTANT, USER], undefined, CONTEXT, [TOOL, added]);
    expect(fixture.permissionListings).toBe(2);
    expect(responseFor(fixture, "updated-list-2")).toMatchObject({
      mcp_response: {
        result: {
          tools: [
            { name: TOOL.name, description: TOOL.description, inputSchema: TOOL.input_schema },
            added,
          ],
        },
      },
    });
  });

  it("keeps fork placeholder correlations in history and sends the current directive outside history records", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const directive =
      "Review the current changes.\nReturn the two most important findings exactly.";
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "cGFzdC1pbWFnZQ==" },
    } as const;
    const parentAssistant: Message = {
      role: "assistant",
      id: "parent-assistant",
      producedAccount: "old-account-metadata",
      content: [
        {
          type: "thinking",
          text: "Past reasoning",
          signature: "old-thinking-signature",
          producedBy: "anthropic",
          producedAccount: "old-account-metadata",
        },
        {
          type: "tool_use",
          id: "fork-call",
          name: "Agent",
          input: { description: "Review child" },
        },
      ],
    };
    const placeholder = {
      type: "tool_result",
      tool_use_id: "fork-call",
      content: [{ type: "text", text: "Fork child started" }, image],
    } as const;
    const last: Message = {
      role: "user",
      id: "fork-current",
      content: [
        { ...placeholder, content: [...placeholder.content] },
        { type: "text", text: directive },
      ],
    };
    const messages: Message[] = [USER, parentAssistant, last];
    const original = structuredClone(messages);
    await run(adapter, messages, undefined, {
      ...CONTEXT,
      agentId: "fork-review",
      agentOwnerId: "child-owner",
    });
    const historical: Message[] = [
      USER,
      parentAssistant,
      { ...last, content: [{ ...placeholder, content: [...placeholder.content] }] },
    ];
    const content = record(fixture.userPosts()[0]?.message, "fork user").content;
    expect(content).toEqual(expectedSnapshot(historical, [{ type: "text", text: directive }]));
    if (!Array.isArray(content)) throw new Error("Missing fork content");
    expect(content.filter((value) => record(value, "block").text === directive)).toHaveLength(1);
    const records = content
      .map((value) => record(value, "block"))
      .filter(
        (block) => typeof block.text === "string" && block.text.includes('"kind":"history_record"'),
      );
    expect(records).toHaveLength(3);
    expect(records.some((block) => String(block.text).includes(directive))).toBe(false);
    expect(record(JSON.parse(String(records[2]?.text)), "last historical record")).toMatchObject({
      role: "user",
      id: "fork-current",
      content: [{ type: "tool_result", tool_use_id: "fork-call" }],
    });
    expect(JSON.stringify(fixture.posts)).not.toContain("old-thinking-signature");
    expect(JSON.stringify(fixture.posts)).not.toContain("old-account-metadata");
    expect(messages).toEqual(original);
    expect(
      fixture.posts.some(
        (post) => post.type === "control_response" && JSON.stringify(post).includes("fork-call"),
      ),
    ).toBe(false);
  });

  it("preserves current user text and image order as native blocks without historical duplication", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "Y3VycmVudC1pbWFnZQ==" },
    } as const;
    const current: Message = {
      role: "user",
      id: "current-image",
      content: [
        {
          type: "text",
          text: "Look at the following current image:",
          cache_control: { type: "ephemeral" },
        },
        image,
        { type: "text", text: "Describe its current colors without changing this text." },
      ],
    };
    await run(adapter, [USER, ASSISTANT, current]);
    const native = [
      { type: "text", text: "Look at the following current image:" },
      image,
      { type: "text", text: "Describe its current colors without changing this text." },
    ];
    const content = record(fixture.userPosts()[0]?.message, "current image request").content;
    expect(content).toEqual(expectedSnapshot([USER, ASSISTANT], native));
    if (!Array.isArray(content)) throw new Error("Missing current image content");
    expect(content.filter((value) => record(value, "block").type === "image")).toHaveLength(1);
    expect(JSON.stringify(content.slice(0, -4))).not.toContain("Y3VycmVudC1pbWFnZQ==");
    expect(JSON.stringify(content)).not.toContain("cache_control");
    const next: Message = { role: "user", content: [{ type: "text", text: "A truly new turn" }] };
    await run(adapter, [USER, ASSISTANT, current, ASSISTANT, next]);
    expect(record(fixture.userPosts()[1]?.message, "incremental user").content).toEqual(
      next.content,
    );
    expect(fixture.creates).toHaveLength(1);
  });

  for (const ending of [ASSISTANT, RESULT, { role: "user" as const, content: RESULT.content }]) {
    it(`keeps ${ending.role}-ending continuation in history and adds an external continuation directive`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter();
      const messages = [USER, ending];
      const events = await run(adapter, messages);
      expect(record(fixture.userPosts()[0]?.message, "continuation").content).toEqual(
        expectedContinuation(messages),
      );
      expect(events.some((event) => event.kind.startsWith("tool_call"))).toBe(false);
      expect(
        fixture.posts.some(
          (post) =>
            post.type === "control_response" &&
            record(post.response, "response").request_id === "call-control",
        ),
      ).toBe(false);
    });
  }

  it("sends cold assistant/tool/image history once as snapshot data, then remains incremental", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "cGl4ZWw=" },
    } as const;
    const history: Message[] = [
      {
        role: "user",
        id: "old-user",
        content: [{ type: "text", text: "Analyze historical image" }, image],
      },
      {
        role: "assistant",
        id: "old-assistant",
        content: [
          {
            type: "tool_use",
            id: "already-completed",
            name: "Calculate",
            input: { expression: "17+25" },
          },
        ],
      },
      {
        role: "tool",
        id: "old-tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: "already-completed",
            content: [{ type: "text", text: "Historical result 42" }, image],
          },
        ],
      },
      { role: "user", id: "new-user", content: [{ type: "text", text: "Use the previous facts" }] },
    ];
    const original = structuredClone(history);
    const events = await run(adapter, history);
    expect(record(fixture.userPosts()[0]?.message, "snapshot").content).toEqual(
      expectedSnapshot(history.slice(0, -1), [{ type: "text", text: "Use the previous facts" }]),
    );
    expect(history).toEqual(original);
    expect(events.some((event) => event.kind.startsWith("tool_call"))).toBe(false);
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" && JSON.stringify(post).includes("already-completed"),
      ),
    ).toBe(false);
    expect(fixture.userPosts()[0]?.session_id).toBe("cse_mock1");
    const next: Message = { role: "user", content: [{ type: "text", text: "Now calculate once" }] };
    fixture.onUser = () => fixture.callTool();
    await run(adapter, [...history, ASSISTANT, next]);
    await run(adapter, [...history, ASSISTANT, next, RESULT]);
    expect(fixture.userPosts()).toHaveLength(2);
    expect(record(fixture.userPosts()[1]?.message, "incremental").content).toEqual(next.content);
    expect(fixture.creates).toHaveLength(1);
    expect(responseFor(fixture, "call-control")).toMatchObject({
      mcp_response: { id: "rpc-42", result: { content: [{ type: "text", text: "42" }] } },
    });
  });

  it("isolates a fork snapshot from the healthy main Cloud session", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    await run(adapter);
    const history: Message[] = [
      USER,
      ASSISTANT,
      { role: "user", content: [{ type: "text", text: "Fork-only task" }] },
    ];
    await run(adapter, history, undefined, {
      ...CONTEXT,
      agentId: "fork-child",
      agentOwnerId: "owner-child",
      subagentLabel: "review",
    });
    expect(fixture.userPosts()[1]?.session_id).toBe("cse_mock2");
    expect(record(fixture.userPosts()[1]?.message, "fork snapshot").content).toEqual(
      expectedSnapshot([USER, ASSISTANT], [{ type: "text", text: "Fork-only task" }]),
    );
    await run(adapter, [
      USER,
      ASSISTANT,
      { role: "user", content: [{ type: "text", text: "Main-only task" }] },
    ]);
    expect(fixture.userPosts()[2]?.session_id).toBe("cse_mock1");
    expect(JSON.stringify(fixture.userPosts()[2])).not.toContain("Fork-only task");
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toHaveLength(0);
  });

  it("changes effort in the same session only after confirming applied effort and model", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    await run(adapter);
    const before = fixture.controls().length;
    await run(adapter, [USER, ASSISTANT, USER], undefined, { ...CONTEXT, effort: "high" });
    expect(fixture.controls().slice(before)).toEqual([
      { subtype: "initialize" },
      { subtype: "list_permission_rules" },
      { subtype: "apply_flag_settings", settings: { effortLevel: "high" } },
      { subtype: "get_settings" },
      { subtype: "initialize" },
      { subtype: "list_permission_rules" },
    ]);
    expect(fixture.userPosts().map((post) => post.session_id)).toEqual(["cse_mock1", "cse_mock1"]);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
    await run(adapter, [USER, ASSISTANT, USER, ASSISTANT, USER], undefined, {
      ...CONTEXT,
      effort: "high",
    });
    expect(
      fixture.controls().filter((request) => request.subtype === "apply_flag_settings"),
    ).toHaveLength(2);
    expect(fixture.current.flagSettings).toEqual({
      env: { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0" },
      effortLevel: "high",
    });
  });

  for (const lostEnv of [{}, { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "120000" }]) {
    it(`fails closed if an effort change loses disabled local tool auto-background (${JSON.stringify(lostEnv)})`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter();
      await run(adapter);
      fixture.onApplySettings = () => {
        fixture.current.flagSettings.env = lostEnv;
      };
      await expect(
        run(adapter, [USER, ASSISTANT, USER], undefined, { ...CONTEXT, effort: "high" }),
      ).rejects.toThrow("auto-background");
      expect(fixture.userPosts()).toHaveLength(1);
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
      const before = fixture.requests.length;
      await expect(run(adapter, [USER, ASSISTANT, USER])).rejects.toThrow("auto-background");
      expect(fixture.requests).toHaveLength(before);
      expect(fixture.archives).toHaveLength(0);
    });
  }

  for (const applied of [
    { effort: "medium", model: "claude-opus-5-5" },
    { effort: "high", model: "other-model" },
    {},
  ]) {
    it(`fails closed when effort settings confirmation disagrees (${JSON.stringify(applied)})`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter();
      await run(adapter);
      fixture.settingsReply = { applied };
      await expect(
        run(adapter, [USER, ASSISTANT, USER], undefined, { ...CONTEXT, effort: "high" }),
      ).rejects.toThrow("get_settings.applied");
      expect(fixture.userPosts()).toHaveLength(1);
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
      await expect(
        run(adapter, [
          { role: "system", content: [{ type: "text", text: "changed after failure" }] },
          USER,
          ASSISTANT,
          USER,
        ]),
      ).rejects.toThrow("get_settings.applied");
      expect(fixture.creates).toHaveLength(1);
    });
  }

  it("revalidates rules after an effort change before submitting user data", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    await run(adapter);
    fixture.onApplySettings = () => {
      fixture.rules = [];
    };
    await expect(
      run(adapter, [USER, ASSISTANT, USER], undefined, { ...CONTEXT, effort: "high" }),
    ).rejects.toThrow("session denies");
    expect(fixture.userPosts()).toHaveLength(1);
    expect(fixture.creates).toHaveLength(1);
  });

  for (const cwd of [
    "/workspace/project with spaces",
    'C:\\Work Trees\\client "quoted"\\project',
    "/workspace/tab\tline\nbreak",
  ]) {
    it(`declares the exact JSON-escaped local CWD (${JSON.stringify(cwd)}) without changing process cwd`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter();
      const route = { ...CONTEXT, cwd };
      const processCwd = process.cwd();
      const request = adapter.translateRequest(route, [USER], [TOOL]);
      expect(request.cwd).toBe(cwd);
      await collect(
        adapter.translateResponse(adapter.stream(route, request, new AbortController().signal)),
      );
      const initialized = fixture
        .controls()
        .find((control) => control.subtype === "initialize" && control.hooks);
      if (!Array.isArray(initialized?.systemPrompt))
        throw new Error("Missing Cloud system guidance");
      const guidance = initialized.systemPrompt.join("\n");
      expect(guidance).toContain(
        `Local working directory on the Otherside client (JSON string): ${JSON.stringify(cwd)}.`,
      );
      expect(guidance).toContain("path arguments refer to the local client filesystem");
      expect(guidance).toContain("do not infer local paths from remote /home/user");
      expect(guidance).toContain("do not silently rewrite tool inputs");
      expect(process.cwd()).toBe(processCwd);
      expect(route.cwd).toBe(cwd);
    });
  }

  it("does not silently rewrite absolute or relative SDK tool paths to the declared CWD", async () => {
    for (const path of [
      "/home/user/note.txt",
      "./directory with spaces/note.txt",
      'C:\\Work Trees\\client "quoted"\\note.txt',
    ]) {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter();
      const route = { ...CONTEXT, cwd: "/workspace/local client" };
      const input = { file_path: path };
      fixture.onUser = () => {
        fixture.assistant(
          "path-intent",
          [{ type: "tool_use", id: "path-call", name: `${MCP_TOOL_PREFIX}Read`, input }],
          {},
        );
        fixture.rpc(
          "tools/call",
          { name: "Read", arguments: input, _meta: { "claudecode/toolUseId": "path-call" } },
          "path-rpc",
          "path-control",
        );
      };
      const events = await run(adapter, [USER], undefined, route, [
        {
          name: "Read",
          description: "Local file read",
          inputSchema: { type: "object", properties: { file_path: { type: "string" } } },
        },
      ]);
      expect(events.filter((event) => event.kind === "tool_call_complete")).toEqual([
        { kind: "tool_call_complete", id: "path-call", name: "Read", input: { file_path: path } },
      ]);
      expect(input.file_path).toBe(path);
    }
  });

  it("rotates safely when a worktree changes local CWD, preserving history and invalidating old bodies", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const original = { ...CONTEXT, cwd: "/workspace/original project" };
    const worktree = { ...CONTEXT, cwd: "/workspace/worktrees/task branch" };
    await run(adapter, [USER], undefined, original);
    const next: Message = {
      role: "user",
      content: [{ type: "text", text: "Continue in the new worktree" }],
    };
    const stale = adapter.translateRequest(original, [USER, ASSISTANT, next], [TOOL]);
    await run(adapter, [USER, ASSISTANT, next], undefined, worktree);
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toEqual(["cse_mock1"]);
    const initialized = fixture
      .controls()
      .filter((control) => control.subtype === "initialize" && control.hooks);
    expect(JSON.stringify(initialized[1]?.systemPrompt)).toContain(worktree.cwd);
    expect(JSON.stringify(initialized[1]?.systemPrompt)).not.toContain(original.cwd);
    expect(record(fixture.userPosts()[1]?.message, "worktree snapshot").content).toEqual(
      expectedSnapshot([USER, ASSISTANT], next.content),
    );
    const before = fixture.requests.length;
    await expect(
      collect(adapter.stream(original, stale, new AbortController().signal)),
    ).rejects.toThrow("predates compaction");
    expect(fixture.requests).toHaveLength(before);
  });

  it("uses each fork's own CWD without rotating or overwriting the main instructions", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const main = { ...CONTEXT, cwd: "/workspace/main project" };
    const fork = {
      ...CONTEXT,
      cwd: "/workspace/fork project",
      agentId: "cwd-fork",
      agentOwnerId: "cwd-owner",
    };
    await run(adapter, [USER], undefined, main);
    await run(adapter, [USER, ASSISTANT, USER], undefined, fork);
    const initialized = fixture
      .controls()
      .filter((control) => control.subtype === "initialize" && control.hooks);
    expect(JSON.stringify(initialized[0]?.systemPrompt)).toContain(main.cwd);
    expect(JSON.stringify(initialized[1]?.systemPrompt)).toContain(fork.cwd);
    expect(JSON.stringify(initialized[1]?.systemPrompt)).not.toContain(main.cwd);
    await run(adapter, [USER, ASSISTANT, USER], undefined, main);
    expect(fixture.userPosts().at(-1)?.session_id).toBe("cse_mock1");
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toHaveLength(0);
  });

  it("rejects a missing CWD and a body prepared for a different working directory before HTTP", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    expect(() => adapter.translateRequest({ ...CONTEXT, cwd: "" }, [USER], [TOOL])).toThrow(
      "local working directory",
    );
    const body = adapter.translateRequest({ ...CONTEXT, cwd: "/workspace/old" }, [USER], [TOOL]);
    await expect(
      collect(
        adapter.stream({ ...CONTEXT, cwd: "/workspace/new" }, body, new AbortController().signal),
      ),
    ).rejects.toThrow("working directory differs");
    expect(fixture.requests).toHaveLength(0);
  });

  it("rotates on system prompt change with a protected worker and the complete snapshot", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const initialSystem: Message = {
      role: "system",
      content: [{ type: "text", text: "Initial instructions" }],
    };
    const newSystem: Message = {
      role: "system",
      content: [{ type: "text", text: "Updated instructions" }],
    };
    await run(adapter, [initialSystem, USER]);
    const history: Message[] = [
      USER,
      {
        role: "assistant",
        id: "fact",
        content: [{ type: "text", text: "Previously observed fact 42" }],
      },
      USER,
    ];
    await run(adapter, [newSystem, ...history]);
    expect(fixture.archives).toEqual(["cse_mock1"]);
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.lifecycle.indexOf("interrupt")).toBeLessThan(
      fixture.lifecycle.indexOf("archive"),
    );
    const initialized = fixture
      .controls()
      .filter((request) => request.subtype === "initialize" && request.hooks);
    expect(initialized).toHaveLength(2);
    expect(initialized[1]?.systemPrompt).toContain("Updated instructions");
    expect(record(fixture.userPosts()[1]?.message, "snapshot").content).toEqual(
      expectedSnapshot(history.slice(0, -1), USER.content),
    );
    expect(fixture.userPosts()[1]?.session_id).toBe("cse_mock2");
  });

  it("rotates within a tool round without sending historical results to the old RPC", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    fixture.onUser = () => fixture.callTool();
    await run(adapter);
    fixture.onUser = () => fixture.finish();
    const toolUse: Message = {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tool-use-42", name: "Calculate", input: { expression: "17+25" } },
      ],
    };
    const history: Message[] = [USER, toolUse, RESULT];
    await run(adapter, [
      { role: "system", content: [{ type: "text", text: "New tool round instructions" }] },
      ...history,
    ]);
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" &&
          record(post.response, "response").request_id === "call-control",
      ),
    ).toBe(false);
    expect(record(fixture.userPosts()[1]?.message, "snapshot").content).toEqual(
      expectedContinuation(history),
    );
    expect(fixture.archives).toEqual(["cse_mock1"]);
    expect(fixture.creates).toHaveLength(2);
  });

  it("recovers from caller Esc only with new input, never by retrying the interrupted request", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const abort = new AbortController();
    const sent = Promise.withResolvers<void>();
    fixture.onUser = () => sent.resolve();
    const running = run(adapter, [USER], abort.signal, { ...CONTEXT, abortSignal: abort.signal });
    await sent.promise;
    abort.abort("user-cancel");
    await expect(running).rejects.toBe("user-cancel");
    expect(fixture.controls().at(-1)).toEqual({ subtype: "interrupt" });
    const before = fixture.requests.length;
    await expect(run(adapter, [USER])).rejects.toThrow("new user prompt or local rejection");
    await expect(
      run(adapter, [
        USER,
        { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
      ]),
    ).rejects.toThrow("new user prompt or local rejection");
    await expect(
      run(adapter, [
        { role: "system", content: [{ type: "text", text: "Changed but no new input" }] },
        USER,
      ]),
    ).rejects.toThrow("new user prompt or local rejection");
    expect(fixture.requests).toHaveLength(before);
    fixture.onUser = () => fixture.finish();
    const history: Message[] = [
      USER,
      { role: "assistant", content: [{ type: "text", text: "Partial facts" }] },
      { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
      { role: "user", content: [{ type: "text", text: "Do this instead" }] },
    ];
    await run(adapter, history);
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toEqual(["cse_mock1"]);
    const content = record(fixture.userPosts()[1]?.message, "snapshot").content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) throw new Error("Expected snapshot content");
    expect(content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("explicitly interrupted"),
    });
    expect(content.slice(1)).toEqual(
      expectedSnapshot(history.slice(0, -1), [{ type: "text", text: "Do this instead" }]),
    );
  });

  for (const errors of [[], [EDE_DIAGNOSTIC]]) {
    it(`recovers caller cancellation before the interrupt POST receipt with errors=${JSON.stringify(errors)}`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter();
      const caller = new AbortController();
      const submitted = Promise.withResolvers<void>();
      fixture.onUser = () => submitted.resolve();
      fixture.interruptEvents = (payload) => {
        fixture.emit({
          type: "control_response",
          response: { subtype: "success", request_id: payload.request_id },
        });
        fixture.assistant("interrupted-partial", [{ type: "text", text: "Partial response" }], {});
        fixture.emit({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: "[Request interrupted by user]" }],
          },
        });
        fixture.emit({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors,
          result: "",
          stop_reason: "tool_use",
        });
      };
      const running = run(adapter, [USER], caller.signal, {
        ...CONTEXT,
        abortSignal: caller.signal,
      });
      await submitted.promise;
      caller.abort("user-cancel");
      await expect(running).rejects.toBe("user-cancel");
      const interrupt = fixture.posts.find(
        (post) =>
          post.type === "control_request" &&
          record(post.request, "request").subtype === "interrupt",
      );
      const id = String(interrupt?.request_id);
      expect(fixture.lifecycle.indexOf(`control-read:${id}`)).toBeGreaterThanOrEqual(0);
      expect(fixture.lifecycle.indexOf(`receipt:${id}`)).toBeGreaterThan(
        fixture.lifecycle.indexOf(`control-read:${id}`),
      );
      await expect(run(adapter, [USER])).rejects.toThrow("new user prompt or local rejection");
      fixture.onUser = () => fixture.finish();
      delete fixture.interruptEvents;
      await run(adapter, [
        USER,
        ASSISTANT,
        { role: "user", content: [{ type: "text", text: "New task after Esc" }] },
      ]);
      expect(fixture.creates).toHaveLength(2);
      expect(fixture.archives).toEqual(["cse_mock1"]);
    });
  }

  for (const diagnostic of [
    { errors: ["AUP refusal [cyber]"] },
    { errors: [EDE_DIAGNOSTIC, "AUP refusal [cyber]"] },
    { errors: [EDE_DIAGNOSTIC, "API request failed"] },
    { errors: [EDE_DIAGNOSTIC, { type: "api_error", message: "API request failed" }] },
    { errors: [EDE_DIAGNOSTIC, null] },
    { errors: EDE_DIAGNOSTIC },
    { errors: ["[ede_diagnostic]missing space"] },
    { errors: [`Quoted ${EDE_DIAGNOSTIC}`] },
    { result: "Security policy rejected the request" },
    { error: { type: "permission_error", message: "Native protection lost" } },
    { error: null },
  ]) {
    it(`classifies rather than ignores diagnostics delivered with the interrupt result (${JSON.stringify(diagnostic)})`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter();
      const caller = new AbortController();
      const submitted = Promise.withResolvers<void>();
      fixture.onUser = () => submitted.resolve();
      fixture.interruptEvents = (payload) => {
        fixture.emit({
          type: "control_response",
          response: { subtype: "success", request_id: payload.request_id },
        });
        fixture.emit({
          type: "user",
          message: { role: "user", content: "[Request interrupted by user]" },
        });
        fixture.emit({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [EDE_DIAGNOSTIC],
          result: "",
          ...diagnostic,
        });
      };
      const running = run(adapter, [USER], caller.signal, {
        ...CONTEXT,
        abortSignal: caller.signal,
      });
      await submitted.promise;
      caller.abort("user-cancel");
      await expect(running).rejects.toBe("user-cancel");
      const before = fixture.requests.length;
      const terminal = ["AUP", "Security policy", "Native protection"].some((text) =>
        JSON.stringify(diagnostic).includes(text),
      );
      const error = await rejection(run(adapter, [USER]));
      expect(error instanceof CloudSessionInterruptedError).toBe(!terminal);
      expect(fixture.requests).toHaveLength(before);
      if (terminal) {
        await expect(run(adapter, [USER, ASSISTANT, USER])).rejects.toThrow();
        expect(fixture.creates).toHaveLength(1);
        expect(fixture.archives).toHaveLength(0);
      } else {
        delete fixture.interruptEvents;
        fixture.onUser = () => fixture.finish();
        await run(adapter, [USER, ASSISTANT, USER]);
        expect(fixture.creates).toHaveLength(2);
        expect(fixture.archives).toEqual(["cse_mock1"]);
      }
    });
  }

  for (const missing of ["ack", "marker", "worker-source", "exact-marker", "result-subtype"]) {
    it(`requires audited detachment instead of consuming cancellation without ${missing} evidence`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter();
      const caller = new AbortController();
      const submitted = Promise.withResolvers<void>();
      fixture.onUser = () => submitted.resolve();
      fixture.interruptEvents = (payload) => {
        fixture.emit({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: missing === "ack" ? "unrelated-control" : payload.request_id,
          },
        });
        if (missing !== "marker")
          fixture.emit(
            {
              type: "user",
              message: {
                role: "user",
                content:
                  missing === "exact-marker"
                    ? "Quoted [Request interrupted by user] text"
                    : "[Request interrupted by user]",
              },
            },
            missing === "worker-source" ? "client" : "worker",
          );
        fixture.emit({
          type: "result",
          subtype: missing === "result-subtype" ? "error_max_turns" : "error_during_execution",
          is_error: true,
          errors: [],
        });
      };
      const running = run(adapter, [USER], caller.signal, {
        ...CONTEXT,
        abortSignal: caller.signal,
      });
      await submitted.promise;
      caller.abort("user-cancel");
      await expect(running).rejects.toBe("user-cancel");
      await expect(run(adapter, [USER])).rejects.toBeInstanceOf(CloudSessionInterruptedError);
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.archives).toHaveLength(0);
      delete fixture.interruptEvents;
      fixture.onUser = () => fixture.finish();
      await run(adapter, [USER, ASSISTANT, USER]);
      expect(fixture.creates).toHaveLength(2);
      expect(fixture.archives).toEqual(["cse_mock1"]);
    });
  }

  it("never clears a structured refusal received before the worker cancellation marker", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const caller = new AbortController();
    const submitted = Promise.withResolvers<void>();
    fixture.onUser = () => submitted.resolve();
    fixture.interruptEvents = (payload) => {
      fixture.emit({
        type: "control_response",
        response: { subtype: "success", request_id: payload.request_id },
      });
      fixture.emit({
        type: "assistant",
        message: {
          id: "shutdown-refusal",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: "refusal",
          stop_details: { type: "refusal", explanation: "AUP refusal [cyber]" },
        },
      });
      fixture.emit({
        type: "user",
        message: { role: "user", content: "[Request interrupted by user]" },
      });
      fixture.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [],
      });
    };
    const running = run(adapter, [USER], caller.signal, { ...CONTEXT, abortSignal: caller.signal });
    await submitted.promise;
    caller.abort("user-cancel");
    await expect(running).rejects.toBe("user-cancel");
    await expect(run(adapter, [USER, ASSISTANT, USER])).rejects.toThrow("AUP refusal [cyber]");
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  it("does not treat a watchdog interrupt result as caller cancellation", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const caller = new AbortController();
    const watchdog = new AbortController();
    const submitted = Promise.withResolvers<void>();
    fixture.onUser = () => submitted.resolve();
    fixture.interruptEvents = (payload) => {
      fixture.emit({
        type: "control_response",
        response: { subtype: "success", request_id: payload.request_id },
      });
      fixture.emit({
        type: "user",
        message: { role: "user", content: "[Request interrupted by user]" },
      });
      fixture.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [],
      });
    };
    const running = run(adapter, [USER], AbortSignal.any([caller.signal, watchdog.signal]), {
      ...CONTEXT,
      abortSignal: caller.signal,
    });
    await submitted.promise;
    watchdog.abort(new DOMException("Internal watchdog expired", "TimeoutError"));
    await expect(running).rejects.toThrow("Internal watchdog expired");
    await expect(run(adapter, [USER])).rejects.toBeInstanceOf(CloudSessionInterruptedError);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
    delete fixture.interruptEvents;
    fixture.onUser = () => fixture.finish();
    await run(adapter, [USER, ASSISTANT, USER]);
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toEqual(["cse_mock1"]);
  });

  it("recovers caller cancellation from a new local rejection result without replaying an old RPC", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const abort = new AbortController();
    const sent = Promise.withResolvers<void>();
    fixture.onUser = () => sent.resolve();
    const running = run(adapter, [USER], abort.signal, { ...CONTEXT, abortSignal: abort.signal });
    await sent.promise;
    abort.abort();
    await expect(running).rejects.toThrow();
    fixture.onUser = () => fixture.finish();
    const rejection: Message = {
      role: "tool",
      content: [
        {
          type: "tool_result",
          tool_use_id: "rejected-before-dispatch",
          content: "Interrupted by user",
          is_error: true,
        },
      ],
    };
    await run(adapter, [USER, rejection]);
    expect(fixture.creates).toHaveLength(2);
    expect(JSON.stringify(fixture.userPosts()[1])).toContain("rejected-before-dispatch");
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" &&
          JSON.stringify(post).includes("rejected-before-dispatch"),
      ),
    ).toBe(false);
  });

  it("rotates pending local rejection plus new prompt without dispatching or replying twice", async () => {
    const fixture = new CloudFixture();
    fixture.onUser = () => fixture.callTool();
    const adapter = fixture.adapter();
    const first = await run(adapter);
    expect(first.filter((event) => event.kind === "tool_call_complete")).toHaveLength(1);
    fixture.onUser = () => fixture.finish();
    const rejection: Message = {
      role: "tool",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-use-42",
          content: "User denied this action",
          is_error: true,
        },
      ],
    };
    const history: Message[] = [
      USER,
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-use-42",
            name: "Calculate",
            input: { expression: "17+25" },
          },
        ],
      },
      rejection,
      { role: "user", content: [{ type: "text", text: "New task instead" }] },
    ];
    const second = await run(adapter, history);
    expect(second.some((event) => event.kind.startsWith("tool_call"))).toBe(false);
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" &&
          record(post.response, "response").request_id === "call-control",
      ),
    ).toBe(false);
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toEqual(["cse_mock1"]);
    expect(JSON.stringify(fixture.userPosts()[1])).toContain("explicitly interrupted");
    expect(JSON.stringify(fixture.userPosts()[1])).toContain("User denied this action");
  });

  it("recognizes caller Esc between tool rounds and snapshots a completed result instead of replaying it", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const caller = new AbortController();
    fixture.onUser = () => fixture.callTool();
    await run(adapter, [USER], caller.signal, { ...CONTEXT, abortSignal: caller.signal });
    caller.abort("user-cancel");
    await expect(run(adapter, [USER])).rejects.toThrow("new user prompt or local rejection");
    fixture.onUser = () => fixture.finish();
    const history: Message[] = [
      USER,
      RESULT,
      { role: "user", content: [{ type: "text", text: "New request after stopping" }] },
    ];
    const events = await run(adapter, history);
    expect(events.some((event) => event.kind.startsWith("tool_call"))).toBe(false);
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" &&
          record(post.response, "response").request_id === "call-control",
      ),
    ).toBe(false);
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toEqual(["cse_mock1"]);
    expect(JSON.stringify(fixture.userPosts()[1])).toContain("explicitly interrupted");
  });

  it("keeps watchdog detachment even when the caller cancels afterwards", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const caller = new AbortController();
    const watchdog = new AbortController();
    const signal = AbortSignal.any([caller.signal, watchdog.signal]);
    const sent = Promise.withResolvers<void>();
    fixture.onUser = () => sent.resolve();
    const running = run(adapter, [USER], signal, { ...CONTEXT, abortSignal: caller.signal });
    await sent.promise;
    watchdog.abort(new DOMException("Content watchdog timeout", "TimeoutError"));
    caller.abort("user-cancel");
    await expect(running).rejects.toThrow("Content watchdog timeout");
    await expect(run(adapter, [USER])).rejects.toBeInstanceOf(CloudSessionInterruptedError);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
    fixture.onUser = () => fixture.finish();
    await run(adapter, [USER, ASSISTANT, USER]);
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toEqual(["cse_mock1"]);
  });

  it("requires audit and archive after failed cancellation cleanup", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const caller = new AbortController();
    const sent = Promise.withResolvers<void>();
    fixture.onUser = () => sent.resolve();
    const running = run(adapter, [USER], caller.signal, { ...CONTEXT, abortSignal: caller.signal });
    await sent.promise;
    fixture.failInterrupt = true;
    caller.abort("user-cancel");
    await expect(running).rejects.toThrow("deny/interrupt cleanup");
    await expect(run(adapter, [USER])).rejects.toBeInstanceOf(CloudSessionInterruptedError);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
    fixture.onUser = () => fixture.finish();
    await run(adapter, [USER, ASSISTANT, USER]);
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toEqual(["cse_mock1"]);
  });

  it("keeps structured refusal terminal across compaction and system rotation", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    fixture.onUser = () => {
      fixture.emit({
        type: "assistant",
        message: {
          id: "refusal",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: "Cannot comply" }],
          stop_reason: "refusal",
          stop_details: { type: "refusal", explanation: "AUP refusal [cyber]" },
        },
      });
      fixture.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Cannot comply",
      });
    };
    expect((await run(adapter)).at(-1)).toEqual({
      kind: "message_stop",
      stop_reason: "refusal",
      refusal: "AUP refusal [cyber]",
    });
    adapter.onCompactionSucceeded(CONTEXT);
    await expect(
      run(adapter, [
        { role: "system", content: [{ type: "text", text: "New instructions" }] },
        USER,
        ASSISTANT,
        USER,
      ]),
    ).rejects.toThrow("AUP refusal [cyber]");
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  it("checks bound account identity before archiving or rotating an interrupted worker", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const caller = new AbortController();
    const sent = Promise.withResolvers<void>();
    fixture.onUser = () => sent.resolve();
    const running = run(adapter, [USER], caller.signal, { ...CONTEXT, abortSignal: caller.signal });
    await sent.promise;
    caller.abort("user-cancel");
    await expect(running).rejects.toBe("user-cancel");
    const before = fixture.requests.length;
    fixture.tokens = { ...fixture.tokens, accountUuid: "different-account" };
    await expect(run(adapter, [USER, ASSISTANT, USER])).rejects.toThrow("identity changed");
    expect(fixture.requests).toHaveLength(before);
    expect(fixture.archives).toHaveLength(0);
    expect(fixture.creates).toHaveLength(1);
  });

  it("revalidates existing worker rules before a system-driven snapshot rotation", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    await run(adapter);
    fixture.rules = [];
    await expect(
      run(adapter, [
        { role: "system", content: [{ type: "text", text: "New instructions" }] },
        USER,
        ASSISTANT,
        USER,
      ]),
    ).rejects.toThrow("session denies");
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  it("compacts between local tool completion and its pending Cloud RPC without replying to the old worker", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    fixture.onUser = () => fixture.callTool();
    await run(adapter);
    adapter.onCompactionSucceeded(CONTEXT);
    fixture.onUser = () => fixture.finish();
    const compacted: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "The local action already completed with value 42; do not repeat it.",
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Continue the remaining task" }] },
    ];
    const events = await run(adapter, compacted);
    expect(events.some((event) => event.kind.startsWith("tool_call"))).toBe(false);
    expect(
      fixture.posts.some(
        (post) =>
          post.type === "control_response" &&
          record(post.response, "response").request_id === "call-control",
      ),
    ).toBe(false);
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toEqual(["cse_mock1"]);
    expect(record(fixture.userPosts()[1]?.message, "snapshot").content).toEqual(
      expectedSnapshot(compacted.slice(0, -1), compacted.at(-1)?.content ?? []),
    );
  });

  it("invalidates all previously prepared bodies when system rotation commits", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    await run(adapter);
    const stale = adapter.translateRequest(CONTEXT, [USER, ASSISTANT, USER], [TOOL]);
    await run(adapter, [
      { role: "system", content: [{ type: "text", text: "Updated system" }] },
      USER,
      ASSISTANT,
      USER,
    ]);
    const before = fixture.requests.length;
    await expect(
      collect(adapter.stream(CONTEXT, stale, new AbortController().signal)),
    ).rejects.toThrow("predates compaction");
    expect(fixture.requests).toHaveLength(before);
    expect(fixture.creates).toHaveLength(2);
  });

  it("keeps a healthy session incremental when an earlier assistant receives a usage/context stamp", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const second: Message = { role: "user", content: [{ type: "text", text: "Second request" }] };
    const third: Message = { role: "user", content: [{ type: "text", text: "Third request" }] };
    await run(adapter);
    await run(adapter, [USER, ASSISTANT, second]);
    const stamped: Message = {
      ...ASSISTANT,
      usage: {
        inputTokens: 200_000,
        outputTokens: 5_000,
        cacheCreationInputTokens: 3_000,
        cacheReadInputTokens: 2_000,
        contextTokens: 50_000,
      },
    };
    const events = await run(adapter, [USER, stamped, second, ASSISTANT, third]);
    expect(events.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
    expect(fixture.userPosts()).toHaveLength(3);
    expect(record(fixture.userPosts()[2]?.message, "new user turn").content).toEqual(third.content);
  });

  it("ignores non-wire message metadata changes after a cold snapshot without replaying history", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const history: Message[] = [
      USER,
      {
        ...ASSISTANT,
        id: "historical-assistant",
        ts: 1,
        requestId: "old-request",
        producedBy: "anthropic",
        producedModel: "historical-model",
        producedAccount: "old-account-stamp",
      },
      USER,
    ];
    await run(adapter, history);
    const updated = history.map((message) => ({
      ...message,
      ts: 2,
      requestId: "new-request-stamp",
      producedBy: "anthropic-cloud" as const,
      producedModel: CONTEXT.model,
      producedAccount: "new-account-stamp",
      usage: {
        inputTokens: 200_000,
        outputTokens: 5_000,
        cacheCreationInputTokens: 3_000,
        cacheReadInputTokens: 2_000,
        contextTokens: 50_000,
      },
    }));
    const next: Message = {
      role: "user",
      content: [{ type: "text", text: "Only this new request" }],
    };
    await run(adapter, [...updated, ASSISTANT, next]);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
    expect(fixture.userPosts()).toHaveLength(2);
    expect(record(fixture.userPosts()[1]?.message, "incremental user turn").content).toEqual(
      next.content,
    );
    expect(JSON.stringify(fixture.posts)).not.toContain("new-request-stamp");
    expect(JSON.stringify(fixture.posts)).not.toContain("new-account-stamp");
  });

  for (const mutation of ["text", "tool-use ID", "tool-result ID", "pixels", "role"] as const) {
    it(`still rejects changed prefix ${mutation} without replay or session replacement`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter();
      const toolUse: Message = {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "historical-call",
            name: "Calculate",
            input: { expression: "17+25" },
          },
        ],
      };
      const toolResult: Message = {
        role: "tool",
        content: [{ type: "tool_result", tool_use_id: "historical-call", content: "42" }],
      };
      const image: Message = {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "b3JpZ2luYWwtcGl4ZWxz" },
          },
        ],
      };
      const history = [USER, toolUse, toolResult, image];
      await run(adapter, history);
      const changed = structuredClone(history);
      if (mutation === "text")
        changed[0] = {
          role: "user",
          content: [{ type: "text", text: "Different historical text" }],
        };
      if (mutation === "tool-use ID")
        changed[1] = {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "different-call",
              name: "Calculate",
              input: { expression: "17+25" },
            },
          ],
        };
      if (mutation === "tool-result ID")
        changed[2] = {
          role: "tool",
          content: [{ type: "tool_result", tool_use_id: "different-call", content: "42" }],
        };
      if (mutation === "pixels")
        changed[3] = {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "Y2hhbmdlZC1waXhlbHM=" },
            },
          ],
        };
      if (mutation === "role") changed[0] = { role: "assistant", content: USER.content };
      const before = fixture.requests.length;
      await expect(run(adapter, [...changed, ASSISTANT, USER])).rejects.toThrow("prefix changed");
      expect(fixture.requests).toHaveLength(before);
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.archives).toHaveLength(0);
      expect(fixture.userPosts()).toHaveLength(1);
    });
  }

  it("rejects unexplained prefix mutations instead of rotating and dropping facts", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    await run(adapter);
    const before = fixture.requests.length;
    await expect(
      run(adapter, [
        { role: "system", content: [{ type: "text", text: "Changed system" }] },
        { role: "user", content: [{ type: "text", text: "Unrelated replacement history" }] },
      ]),
    ).rejects.toThrow("prefix changed");
    expect(fixture.requests).toHaveLength(before);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  it("preserves an AUP failure when caller cancellation happens during error delivery", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const caller = new AbortController();
    const ctx = { ...CONTEXT, abortSignal: caller.signal };
    fixture.onUser = () =>
      fixture.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["AUP refusal [cyber]"],
      });
    const stream = adapter.translateResponse(
      adapter.stream(ctx, adapter.translateRequest(ctx, [USER], [TOOL]), caller.signal),
    );
    for await (const event of stream) {
      if (event.kind === "error") caller.abort("user-cancel");
    }
    await expect(run(adapter, [USER, ASSISTANT, USER])).rejects.toThrow("AUP refusal [cyber]");
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  for (const subtype of ["title", "compact"]) {
    it(`places the literal bootstrap exception in system instructions for ${subtype}`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter();
      const instructions = `Return only a ${subtype}, do not use tools.`;
      const context: RequestContext = {
        ...CONTEXT,
        ...(subtype === "title" ? { requestRole: "title" as const } : { isCompaction: true }),
      };
      const control = fixture.control.bind(fixture);
      fixture.control = (payload) => {
        const request = record(payload.request, "request");
        if (request.subtype === "initialize" && request.hooks) {
          expect(request.systemPrompt).toEqual([
            instructions,
            expect.stringContaining("Initialization-only exception"),
          ]);
        }
        control(payload);
      };
      await run(
        adapter,
        [{ role: "system", content: [{ type: "text", text: instructions }] }, USER],
        undefined,
        context,
        [],
      );
      const initialize = fixture
        .controls()
        .find((request) => request.subtype === "initialize" && request.hooks);
      const prompts = initialize?.systemPrompt;
      if (!Array.isArray(prompts)) throw new Error("Missing initialization prompts");
      const bootstrap = fixture.posts.find((post) => post.type === "user");
      const literal = record(bootstrap?.message, "bootstrap message").content;
      expect(String(prompts[1])).toContain(JSON.stringify(literal));
      expect(String(prompts[1])).toContain("exception ends after that callback");
      expect(responseFor(fixture, "updated-list-1")).toMatchObject({
        mcp_response: { result: { tools: [] } },
      });
      expect(record(fixture.userPosts()[0]?.message, "real prompt").content).toEqual(USER.content);
    });
  }

  for (const mode of ["system-change", "compaction"] as const) {
    for (const diagnostic of [
      {
        name: "AUP result",
        payload: {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["AUP terminal during rotation"],
        },
        message: "AUP terminal during rotation",
      },
      {
        name: "worker error",
        payload: { type: "error", errors: ["Security failure during rotation"] },
        message: "Security failure during rotation",
      },
      {
        name: "structured refusal",
        payload: {
          type: "assistant",
          message: {
            id: "rotation-refusal",
            model: "claude-opus-5-5",
            content: [],
            stop_reason: "refusal",
            stop_details: { type: "refusal", explanation: "Refusal during rotation" },
          },
        },
        message: "Refusal during rotation",
      },
    ]) {
      it(`blocks ${mode} snapshot rotation when ${diagnostic.name} arrives before the interrupt receipt`, async () => {
        const fixture = new CloudFixture();
        const adapter = fixture.adapter();
        await run(adapter);
        fixture.interruptEvents = (payload) => {
          fixture.emit(diagnostic.payload);
          fixture.emit({
            type: "control_response",
            response: { subtype: "success", request_id: payload.request_id },
          });
        };
        if (mode === "compaction") adapter.onCompactionSucceeded(CONTEXT);
        const messages: Message[] =
          mode === "system-change"
            ? [
                { role: "system", content: [{ type: "text", text: "Changed system" }] },
                USER,
                ASSISTANT,
                USER,
              ]
            : [
                {
                  role: "user",
                  content: [{ type: "text", text: "Compacted transcript; next task" }],
                },
              ];
        await expect(run(adapter, messages)).rejects.toThrow(diagnostic.message);
        const interrupt = fixture.posts.find(
          (post) =>
            post.type === "control_request" &&
            record(post.request, "request").subtype === "interrupt",
        );
        const id = String(interrupt?.request_id);
        expect(fixture.lifecycle.indexOf(`control-read:${id}`)).toBeGreaterThanOrEqual(0);
        expect(fixture.lifecycle.indexOf(`receipt:${id}`)).toBeGreaterThan(
          fixture.lifecycle.indexOf(`control-read:${id}`),
        );
        const before = fixture.requests.length;
        adapter.onCompactionSucceeded(CONTEXT);
        await expect(run(adapter, messages)).rejects.toThrow(diagnostic.message);
        expect(fixture.requests).toHaveLength(before);
        expect(fixture.creates).toHaveLength(1);
        expect(fixture.archives).toHaveLength(0);
        expect(fixture.userPosts()).toHaveLength(1);
        expect(fixture.live.size).toBe(0);
      });
    }
  }

  it("retires main and auxiliary workers across two consecutive compacted histories", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const compactCtx: RequestContext = { ...CONTEXT, isCompaction: true };
    const instructions: Message = {
      role: "system",
      content: [{ type: "text", text: "Return only the summary." }],
    };
    await run(adapter);
    const firstHistory = [USER, ASSISTANT, USER];
    await run(adapter, [instructions, ...firstHistory], undefined, compactCtx, []);
    const staleFirstSummary = adapter.translateRequest(
      compactCtx,
      [instructions, ...firstHistory],
      [],
    );
    adapter.onCompactionSucceeded(CONTEXT);
    const firstReduced: Message[] = [
      {
        role: "assistant",
        id: "summary-one",
        content: [{ type: "text", text: "First compacted facts." }],
      },
      { role: "user", content: [{ type: "text", text: "Continue after the first summary." }] },
    ];
    await run(adapter, firstReduced);
    const secondSummary = await run(
      adapter,
      [instructions, ...firstReduced, ASSISTANT],
      undefined,
      compactCtx,
      [],
    );
    expect(secondSummary.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
    expect(fixture.creates).toHaveLength(4);
    expect(fixture.archives).toEqual(["cse_mock1", "cse_mock2"]);
    expect(record(fixture.userPosts()[3]?.message, "second summary snapshot").content).toEqual(
      expectedContinuation([...firstReduced, ASSISTANT]),
    );
    await expect(
      collect(adapter.stream(compactCtx, staleFirstSummary, new AbortController().signal)),
    ).rejects.toThrow("predates compaction");
    const staleMain = adapter.translateRequest(CONTEXT, firstReduced, [TOOL]);
    const staleSecondSummary = adapter.translateRequest(
      compactCtx,
      [instructions, ...firstReduced, ASSISTANT],
      [],
    );
    adapter.onCompactionSucceeded(CONTEXT);
    await expect(
      collect(adapter.stream(CONTEXT, staleMain, new AbortController().signal)),
    ).rejects.toThrow("predates compaction");
    await expect(
      collect(adapter.stream(compactCtx, staleSecondSummary, new AbortController().signal)),
    ).rejects.toThrow("predates compaction");
    const secondReduced: Message[] = [
      {
        role: "assistant",
        id: "summary-two",
        content: [{ type: "text", text: "Second compacted facts." }],
      },
      { role: "user", content: [{ type: "text", text: "Continue after the second summary." }] },
    ];
    await run(adapter, secondReduced);
    expect(fixture.userPosts()[4]?.session_id).toBe("cse_mock5");
    expect(fixture.archives).toEqual(["cse_mock1", "cse_mock2", "cse_mock3"]);
    expect(record(fixture.userPosts()[4]?.message, "second reduced main snapshot").content).toEqual(
      expectedSnapshot(secondReduced.slice(0, -1), [
        { type: "text", text: "Continue after the second summary." },
      ]),
    );
  });

  it("does not retire either worker if the auxiliary compaction reader is still busy", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const compactCtx: RequestContext = { ...CONTEXT, isCompaction: true };
    await run(adapter);
    const preparedMain = adapter.translateRequest(CONTEXT, [USER, ASSISTANT, USER], [TOOL]);
    const submitted = Promise.withResolvers<void>();
    fixture.onUser = () => submitted.resolve();
    const compacting = run(adapter, [USER, ASSISTANT], undefined, compactCtx, []);
    await submitted.promise;
    try {
      expect(() => adapter.onCompactionSucceeded(CONTEXT)).toThrow("active Cloud reader");
    } finally {
      fixture.finish();
      await compacting;
    }
    fixture.onUser = () => fixture.finish();
    const events = await collect(
      adapter.translateResponse(
        adapter.stream(CONTEXT, preparedMain, new AbortController().signal),
      ),
    );
    expect(events.at(-1)).toEqual({ kind: "message_stop", stop_reason: "stop" });
    expect(fixture.userPosts().at(-1)?.session_id).toBe("cse_mock1");
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toHaveLength(0);
  });

  it("never retires a failed auxiliary compaction worker to bypass AUP", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const compactCtx: RequestContext = { ...CONTEXT, isCompaction: true };
    await run(adapter);
    fixture.onUser = () =>
      fixture.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["AUP refusal [cyber]"],
      });
    const events = await run(adapter, [USER, ASSISTANT], undefined, compactCtx, []);
    expect(events).toContainEqual({ kind: "error", error: "AUP refusal [cyber]" });
    adapter.onCompactionSucceeded(CONTEXT);
    const before = fixture.requests.length;
    await expect(run(adapter, [ASSISTANT, USER], undefined, compactCtx, [])).rejects.toThrow(
      "AUP refusal [cyber]",
    );
    expect(fixture.requests).toHaveLength(before);
    fixture.onUser = () => fixture.finish();
    await run(adapter, [USER, ASSISTANT, USER]);
    expect(fixture.userPosts().at(-1)?.session_id).toBe("cse_mock1");
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toHaveLength(0);
  });

  it("checks the auxiliary worker's bound identity before retirement after compaction", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    const compactCtx: RequestContext = { ...CONTEXT, isCompaction: true };
    await run(adapter, [USER, ASSISTANT], undefined, compactCtx, []);
    adapter.onCompactionSucceeded(CONTEXT);
    const before = fixture.requests.length;
    fixture.tokens = { ...fixture.tokens, accountUuid: "other-summary-account" };
    await expect(run(adapter, [ASSISTANT, USER], undefined, compactCtx, [])).rejects.toThrow(
      "identity changed",
    );
    expect(fixture.requests).toHaveLength(before);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.archives).toHaveLength(0);
  });

  it("invalidates stale requests on compaction and snapshots the new local history once", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    await run(adapter);
    const stale = adapter.translateRequest(CONTEXT, [USER, ASSISTANT], [TOOL]);
    adapter.onCompactionSucceeded(CONTEXT);
    await expect(
      collect(adapter.stream(CONTEXT, stale, new AbortController().signal)),
    ).rejects.toThrow("predates compaction");
    const compacted: Message[] = [
      {
        role: "assistant",
        id: "summary",
        content: [{ type: "text", text: "Previously completed task facts" }],
      },
      USER,
    ];
    await run(adapter, compacted);
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.archives).toEqual(["cse_mock1"]);
    expect(record(fixture.userPosts()[1]?.message, "snapshot").content).toEqual(
      expectedSnapshot(compacted.slice(0, -1), compacted.at(-1)?.content ?? []),
    );
    const next: Message = {
      role: "user",
      content: [{ type: "text", text: "Continue from summary" }],
    };
    await run(adapter, [...compacted, ASSISTANT, next]);
    expect(fixture.creates).toHaveLength(2);
    expect(record(fixture.userPosts()[2]?.message, "incremental").content).toEqual(next.content);
  });

  it("rejects missing or unsupported models before creating a worker", () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    expect(() => adapter.translateRequest({ ...CONTEXT, model: "" }, [USER], [TOOL])).toThrow(
      "requested model",
    );
    expect(() =>
      adapter.translateRequest({ ...CONTEXT, model: "claude-sonnet-5-5" }, [USER], [TOOL]),
    ).toThrow("only claude-opus-5-5");
    expect(() =>
      adapter.translateRequest(CONTEXT, [USER], [{ ...TOOL, name: CLOUD_CONNECT_TOOL_NAME }]),
    ).toThrow("reserved");
    expect(fixture.requests).toHaveLength(0);
  });

  for (const key of ["accountUuid", "organizationUuid"] as const) {
    it(`refuses account continuity after ${key} changes without sending session data`, async () => {
      const fixture = new CloudFixture();
      const adapter = fixture.adapter();
      await run(adapter);
      const before = fixture.requests.length;
      fixture.tokens = { ...fixture.tokens, [key]: "new-identity" };
      await expect(run(adapter, [USER, ASSISTANT, USER])).rejects.toThrow("identity changed");
      expect(fixture.requests).toHaveLength(before);
      expect(fixture.creates).toHaveLength(1);
    });
  }

  it("accepts token refresh without changing stable account identity", async () => {
    const fixture = new CloudFixture();
    const adapter = fixture.adapter();
    await run(adapter);
    const before = fixture.requests.length;
    fixture.tokens = { ...fixture.tokens, accessToken: "mock-refreshed" };
    await run(adapter, [USER, ASSISTANT, USER]);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.userPosts()).toHaveLength(2);
    for (const request of fixture.requests.slice(before)) {
      expect(new Headers(request.init.headers).get("authorization")).toBe("Bearer mock-refreshed");
    }
  });

  it("separates fork, owner, title and compaction identities", () => {
    const contexts = [
      CONTEXT,
      { ...CONTEXT, agentId: "fork" },
      { ...CONTEXT, agentOwnerId: "owner" },
      { ...CONTEXT, requestRole: "title" as const },
      { ...CONTEXT, cacheRole: "title" as const },
      { ...CONTEXT, subagentLabel: "label" },
      { ...CONTEXT, isCompaction: true },
    ];
    expect(new Set(contexts.map(cloudSessionKey)).size).toBe(contexts.length);
  });
});
