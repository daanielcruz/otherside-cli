import { describe, expect, it } from "bun:test";
import { ProviderHttpError } from "@/engine/providers/_shared/retry.ts";
import {
  CloudClient,
  type CloudClientOptions,
  type CloudCursor,
  encodeCloudEvent,
} from "../client.ts";

const TOKENS = { accessToken: "mock-access-token", organizationUuid: "mock-organization" };
const INPUT = {
  title: "Fixture",
  environmentId: "env_fixture",
  model: "claude-opus-5-5",
  effort: "medium",
  signal: new AbortController().signal,
};
const EVENT = {
  event_id: "durable-one",
  sequence_num: "9007199254740993",
  event_type: "message",
  payload: {
    type: "assistant",
    message: { id: "message-one", content: [{ type: "text", text: "ação" }] },
  },
};

function client(
  fetch: NonNullable<CloudClientOptions["fetch"]>,
  options: Partial<CloudClientOptions> = {},
) {
  return new CloudClient({
    currentTokens: async () => TOKENS,
    userAgent: "claude-code/test",
    fetch,
    ...options,
  });
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of source) result.push(value);
  return result;
}

describe("Cloud REST and SSE transport", () => {
  it("uses official OAuth CLI headers without messages API or credential logging", async () => {
    let request: RequestInit | undefined;
    let url = "";
    const api = client(async (address, init) => {
      url = address;
      request = init;
      return Response.json({ session: { id: "cse_fixture" }, deduplicated: false });
    });
    expect(await api.createSession(INPUT)).toBe("cse_fixture");
    expect(url).toBe("https://api.anthropic.com/v1/code/sessions");
    expect(Object.fromEntries(new Headers(request?.headers))).toEqual({
      authorization: "Bearer mock-access-token",
      "anthropic-version": "2023-06-01",
      "anthropic-client-platform": "claude_code_cli",
      "content-type": "application/json",
      "x-organization-uuid": "mock-organization",
      "user-agent": "claude-code/test",
    });
    expect(request?.redirect).toBe("error");
    expect(String(request?.body)).not.toContain(TOKENS.accessToken);
  });

  it("archives its bound session through the observed empty-body endpoint and rejects account changes", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    let tokens = { ...TOKENS, accountUuid: "mock-account" };
    const api = client(
      async (url, init) => {
        requests.push({ url, init });
        return Response.json({});
      },
      { currentTokens: async () => tokens },
    );
    const bound = await api.bindCurrentIdentity();
    await bound.archiveSession("cse_fixture", INPUT.signal);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.anthropic.com/v1/code/sessions/cse_fixture/archive");
    expect(requests[0]?.init.method).toBe("POST");
    expect(requests[0]?.init.body).toBe("{}");
    tokens = { ...tokens, accountUuid: "changed-account" };
    await expect(bound.archiveSession("cse_fixture", INPUT.signal)).rejects.toThrow(
      "identity changed",
    );
    expect(requests).toHaveLength(1);
  });

  it("rejects missing organization identity before issuing a request", async () => {
    let fetched = false;
    const api = client(
      async () => {
        fetched = true;
        throw new Error("must not fetch");
      },
      {
        currentTokens: async () => ({ accessToken: "mock-token" }),
      },
    );
    await expect(api.createSession(INPUT)).rejects.toThrow("organizationUuid");
    expect(fetched).toBe(false);
  });

  it("preserves HTTP quota/error metadata and redacts a reflected access token", async () => {
    const api = client(
      async () =>
        new Response(
          JSON.stringify({
            error: { type: "insufficient_quota", message: `Quota exhausted ${TOKENS.accessToken}` },
          }),
          { status: 429, headers: { "retry-after": "60" } },
        ),
    );
    let observed: unknown;
    try {
      await api.createSession(INPUT);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(ProviderHttpError);
    expect(observed).toMatchObject({ status: 429, quotaExhausted: true });
    expect(String(observed)).toContain("Quota exhausted");
    expect(String(observed)).not.toContain(TOKENS.accessToken);
  });

  it("decodes split UTF-8/CRLF frames, ignores notifications and deduplicates IDs and bigint sequences", async () => {
    const cursor: CloudCursor = { sequence: "0", eventIds: new Set() };
    let listCalls = 0;
    const api = client(async (url) => {
      if (!url.includes("/stream?")) {
        listCalls++;
        return Response.json({
          data: listCalls === 1 ? [EVENT] : [],
          resume_cursor: cursor.sequence,
        });
      }
      const next = {
        ...EVENT,
        event_id: "durable-two",
        sequence_num: "9007199254740994",
        payload: { type: "result", subtype: "success" },
      };
      const encoder = new TextEncoder();
      const frames = [
        encodeCloudEvent(EVENT),
        encodeCloudEvent({ ...EVENT, event_id: "same-sequence" }),
        encodeCloudEvent({ ...EVENT, sequence_num: "9007199254740994" }),
        encoder.encode(":keepalive\r\n\r\nevent: delivery_update\r\ndata: {}\r\n\r\n"),
        encoder.encode(
          'event: ephemeral_event\r\ndata: {"event_type":"post_turn_summary","payload":{"text":"ação"}}\r\n\r\n',
        ),
        encodeCloudEvent(next),
      ];
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const frame of frames)
              for (const byte of frame) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        }),
      );
    });
    const values = [];
    for await (const value of api.events("cse_fixture", cursor, INPUT.signal)) {
      values.push(value);
      if (value?.payload.type === "result") break;
    }
    expect(values).toHaveLength(4);
    expect(values[0]).toEqual(EVENT);
    expect(values[1]).toBeNull();
    expect(values[2]?.payload).toEqual({ text: "ação" });
    expect(cursor.sequence).toBe("9007199254740994");
  });

  it("announces SSE readiness independently of catch-up and before any stream event", async () => {
    const connectionRequested = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const opened = Promise.withResolvers<void>();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let didOpen = false;
    const api = client(async (url) => {
      if (!url.includes("/stream?"))
        return Response.json({ data: [EVENT], resume_cursor: EVENT.sequence_num });
      connectionRequested.resolve();
      return response.promise;
    });
    const iterator = api.events(
      "cse_fixture",
      { sequence: "0", eventIds: new Set() },
      INPUT.signal,
      {
        onOpen: () => {
          didOpen = true;
          opened.resolve();
        },
        onReconnect: () => {
          throw new Error("Unexpected reconnect");
        },
      },
    );
    expect((await iterator.next()).value).toEqual(EVENT);
    expect(didOpen).toBe(false);
    const pending = iterator.next();
    await connectionRequested.promise;
    expect(didOpen).toBe(false);
    response.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(output) {
            controller = output;
          },
        }),
      ),
    );
    await opened.promise;
    expect(didOpen).toBe(true);
    const ephemeral = {
      event_type: "message",
      payload: {
        type: "control_response",
        response: { subtype: "success", request_id: "ephemeral-id", response: {} },
      },
    };
    controller?.enqueue(encodeCloudEvent(ephemeral));
    expect((await pending).value).toEqual(ephemeral);
    await iterator.return(undefined);
  });

  it("never announces readiness for a rejected SSE request", async () => {
    let opened = false;
    const api = client(async (url) =>
      url.includes("/stream?")
        ? new Response("Mock denied stream", { status: 403 })
        : Response.json({ data: [], resume_cursor: "0" }),
    );
    await expect(
      collect(
        api.events("cse_fixture", { sequence: "0", eventIds: new Set() }, INPUT.signal, {
          onOpen: () => {
            opened = true;
          },
          onReconnect: () => {
            throw new Error("Unexpected reconnect");
          },
        }),
      ),
    ).rejects.toThrow("403");
    expect(opened).toBe(false);
  });

  it("reconnects through durable history at the last cursor", async () => {
    const cursor: CloudCursor = { sequence: "0", eventIds: new Set() };
    const urls: string[] = [];
    let pages = 0;
    const api = client(async (url) => {
      urls.push(url);
      if (url.includes("/stream?")) return new Response("");
      pages++;
      return Response.json({ data: pages === 2 ? [EVENT] : [], resume_cursor: cursor.sequence });
    });
    for await (const event of api.events("cse_fixture", cursor, INPUT.signal)) {
      expect(event).toEqual(EVENT);
      break;
    }
    expect(urls.map((url) => new URL(url).pathname)).toEqual([
      "/v1/code/sessions/cse_fixture/events",
      "/v1/code/sessions/cse_fixture/events/stream",
      "/v1/code/sessions/cse_fixture/events",
    ]);
    expect(urls[1]).toContain("from_sequence_num=0");
  });

  it("stops after bounded empty reconnects rather than declaring a successful round", async () => {
    const api = client(
      async (url) =>
        url.includes("/stream?")
          ? new Response("")
          : Response.json({ data: [], resume_cursor: "0" }),
      { maxReconnects: 1 },
    );
    await expect(
      collect(api.events("cse_fixture", { sequence: "0", eventIds: new Set() }, INPUT.signal)),
    ).rejects.toThrow("not resubmitted");
  });

  it("discovers environments using the OAuth endpoint and selects the first active cloud entry", async () => {
    const requests: string[] = [];
    const api = client(async (url) => {
      requests.push(url);
      return Response.json({
        environments: [
          { kind: "local", environment_id: "env_local", state: "active", name: "Default" },
          { kind: "anthropic_cloud", environment_id: "env_inactive", state: "inactive" },
          {
            kind: "anthropic_cloud",
            environment_id: "env_first",
            state: "active",
            name: "Fixture A",
          },
          {
            kind: "anthropic_cloud",
            environment_id: "env_second",
            state: "active",
            name: "Default",
          },
        ],
        has_more: false,
        first_id: "env_local",
        last_id: "env_second",
      });
    });
    expect(await api.resolveEnvironment(undefined, INPUT.signal)).toBe("env_first");
    expect(await api.resolveEnvironment(" env_second ", INPUT.signal)).toBe("env_second");
    await expect(api.resolveEnvironment("env_inactive", INPUT.signal)).rejects.toThrow(
      "not an active",
    );
    await expect(api.resolveEnvironment("env_local", INPUT.signal)).rejects.toThrow(
      "not an active",
    );
    expect(requests).toEqual(Array(4).fill("https://api.anthropic.com/v1/environment_providers"));
  });

  it("fails on partial environment discovery unless the explicit active ID is present", async () => {
    const api = client(async () =>
      Response.json({
        environments: [{ kind: "anthropic_cloud", environment_id: "env_first", state: "active" }],
        has_more: true,
        first_id: "env_first",
        last_id: "env_first",
      }),
    );
    await expect(api.resolveEnvironment(undefined, INPUT.signal)).rejects.toThrow("partial");
    await expect(api.resolveEnvironment("env_missing", INPUT.signal)).rejects.toThrow("partial");
    expect(await api.resolveEnvironment("env_first", INPUT.signal)).toBe("env_first");
  });

  it("rejects empty or malformed environment discovery", async () => {
    const empty = client(async () => Response.json({ environments: [], has_more: false }));
    await expect(empty.resolveEnvironment(undefined, INPUT.signal)).rejects.toThrow("No active");
    const malformed = client(async () =>
      Response.json({
        environments: [{ kind: "anthropic_cloud", state: "active" }],
        has_more: false,
      }),
    );
    await expect(malformed.resolveEnvironment(undefined, INPUT.signal)).rejects.toThrow(
      "environment_id",
    );
  });

  it("rejects a malformed durable envelope instead of silently losing a control", async () => {
    const api = client(async () =>
      Response.json({
        data: [{ event_id: "broken", event_type: "message", payload: { type: "control_request" } }],
        resume_cursor: "0",
      }),
    );
    await expect(
      collect(api.events("cse_fixture", { sequence: "0", eventIds: new Set() }, INPUT.signal)),
    ).rejects.toThrow("sequence_num");
  });
});
