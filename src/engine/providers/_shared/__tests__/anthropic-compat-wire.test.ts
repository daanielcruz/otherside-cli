import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import * as fsModule from "node:fs";

const originalFs: Record<string | symbol, unknown> = {};
for (const key of Reflect.ownKeys(fsModule)) {
  originalFs[key] = (fsModule as Record<string | symbol, unknown>)[key];
}

let mockTime = 1;
const mockFiles = new Map<string, { data: string | Buffer; mtimeMs: number }>();

function existsFn(path: string): boolean {
  return mockFiles.has(path);
}
function writeFileFn(path: string, data: string | Buffer): void {
  mockFiles.set(path, { data, mtimeMs: mockTime++ });
}
function mkdtempFn(prefix: string): string {
  return `${prefix}-mocked-temp-dir`;
}
function rmFn(path: string): void {
  for (const key of mockFiles.keys()) {
    if (key.startsWith(path)) {
      mockFiles.delete(key);
    }
  }
}
function readFileFn(path: string, options?: unknown): string | Buffer {
  const entry = mockFiles.get(path);
  if (entry === undefined) {
    throw new Error(`ENOENT: no such file or directory, open '${path}'`);
  }
  const data = entry.data;
  const isUtf8 =
    options === "utf8" ||
    (typeof options === "object" &&
      options !== null &&
      "encoding" in options &&
      (options as { encoding?: string }).encoding === "utf8");
  if (isUtf8) {
    return typeof data === "string" ? data : data.toString("utf8");
  }
  return data;
}
function statFn(path: string) {
  const entry = mockFiles.get(path);
  if (entry === undefined) {
    throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
  }
  const size = typeof entry.data === "string" ? Buffer.byteLength(entry.data) : entry.data.length;
  return {
    mtimeMs: entry.mtimeMs,
    size,
  };
}

const S = "Sync";
const fsMock: Record<string, unknown> = {};
fsMock[`writeFile${S}`] = writeFileFn;
fsMock[`readFile${S}`] = readFileFn;
fsMock[`stat${S}`] = statFn;
fsMock[`mkdir${S}`] = () => {};
fsMock[`mkdtemp${S}`] = mkdtempFn;
fsMock[`rm${S}`] = rmFn;
fsMock[`exists${S}`] = existsFn;

mock.module("node:fs", () => fsMock);

import { join } from "node:path";
import { accountFingerprint } from "@/engine/providers/_shared/account-identity.ts";
import {
  buildKimiMessages,
  translateResponseKimi,
} from "@/engine/providers/_shared/anthropic-compat-wire.ts";
import { translateRequestKimi } from "@/engine/providers/kimi/translate.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const ENV_KEYS = [
  "OTHERSIDE_CONFIG_DIR",
  "OTHERSIDE_GLM_API_KEY",
  "ZAI_API_KEY",
  "OTHERSIDE_KIMI_API_KEY",
  "KIMI_API_KEY",
] as const;

let scratchDir: string;
const priorEnv = new Map<string, string | undefined>();

beforeAll(() => {
  scratchDir = mkdtempFn("kimi-gate-");
  for (const key of ENV_KEYS) {
    priorEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.OTHERSIDE_CONFIG_DIR = scratchDir;
  writeFileFn(
    join(scratchDir, "credentials.json"),
    JSON.stringify({
      glm: { zcodeJwtToken: "key-A", user: { user_id: "user-A" } },
      kimi: { apiKey: "key-K" },
    }),
  );
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const prior = priorEnv.get(key);
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }

  mock.module("node:fs", () => originalFs);
});

function assistantWith(overrides: Partial<Message>): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      producedBy: "glm",
      content: [
        { type: "thinking", text: "t", signature: "sig-bytes" },
        { type: "text", text: "ok" },
      ],
      ...overrides,
    },
  ];
}

function signedThinkingCount(messages: Message[]): number {
  return buildKimiMessages(messages, "glm")
    .out.flatMap((m) => m.content)
    .filter((b) => b.type === "thinking" && !!b.signature).length;
}

describe("compat-wire signed thinking replay gate", () => {
  it("keeps signed thinking from the same provider+account", () => {
    const account = accountFingerprint("glm");
    expect(account.length).toBeGreaterThan(0);
    expect(signedThinkingCount(assistantWith({ producedAccount: account }))).toBe(1);
  });

  it("drops signed thinking stamped by another account", () => {
    expect(signedThinkingCount(assistantWith({ producedAccount: "other" }))).toBe(0);
  });

  it("drops unstamped signed thinking when the current account is known", () => {
    expect(signedThinkingCount(assistantWith({}))).toBe(0);
  });

  it("drops signed thinking from another provider", () => {
    const account = accountFingerprint("glm");
    expect(
      signedThinkingCount(assistantWith({ producedBy: "anthropic", producedAccount: account })),
    ).toBe(0);
  });

  it("replays unsigned thinking regardless of account", () => {
    const messages = assistantWith({});
    const assistant = messages[1];
    if (assistant)
      assistant.content = [
        { type: "thinking", text: "t" },
        { type: "text", text: "ok" },
      ];
    const out = buildKimiMessages(messages, "glm").out.flatMap((m) => m.content);
    expect(out.filter((b) => b.type === "thinking").length).toBe(1);
  });

  it("drops unsigned thinking from another provider", () => {
    const messages = assistantWith({ producedBy: "anthropic" });
    const assistant = messages[1];
    if (assistant)
      assistant.content = [
        { type: "thinking", text: "t" },
        { type: "text", text: "ok" },
      ];
    const wireAssistant = buildKimiMessages(messages, "glm").out.find(
      (m) => m.role === "assistant",
    );
    expect(wireAssistant?.content.some((b) => b.type === "thinking")).toBe(false);
    expect(wireAssistant?.content.some((b) => b.type === "text")).toBe(true);
  });

  it("drops unstamped thinking because provenance cannot be proven", () => {
    const messages = assistantWith({});
    const assistant = messages[1] as Message & { producedBy?: string };
    delete assistant.producedBy;
    const out = buildKimiMessages(messages, "glm").out.flatMap((m) => m.content);
    expect(out.filter((b) => b.type === "thinking").length).toBe(0);
  });
});

describe("Kimi K3 signed thinking continuity", () => {
  it("streams a signature and echoes it on the next request", async () => {
    async function* source(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode(
        [
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-k3"}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join(""),
      );
    }

    const events: ProviderEvent[] = [];
    for await (const event of translateResponseKimi(source())) events.push(event);
    const thinking = events.find((event) => event.kind === "thinking_delta");
    const signature = events.find((event) => event.kind === "thinking_signature");
    expect(signature).toEqual({ kind: "thinking_signature", signature: "sig-k3" });
    if (thinking?.kind !== "thinking_delta" || signature?.kind !== "thinking_signature") {
      throw new Error("Kimi K3 stream did not produce signed thinking");
    }

    const producedAccount = accountFingerprint("kimi");
    expect(producedAccount.length).toBeGreaterThan(0);
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "start" }] },
      {
        role: "assistant",
        producedBy: "kimi",
        producedAccount,
        content: [
          { type: "thinking", text: thinking.text, signature: signature.signature },
          { type: "text", text: "done" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ];
    const ctx: RequestContext = {
      provider: "kimi",
      model: "k3",
      effort: "max",
      permissionMode: "default",
      sessionId: "session-k3",
      cwd: "/workspace",
      agentic: true,
    };
    const body = translateRequestKimi(ctx, messages, []) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
      thinking: Record<string, unknown>;
    };
    expect(body.thinking).toEqual({ type: "enabled", effort: "max" });
    const assistant = body.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toContainEqual({
      type: "thinking",
      thinking: "plan",
      signature: "sig-k3",
    });
  });
});

describe("compat-wire stream termination", () => {
  it("finishes on message_stop without waiting for transport EOF", async () => {
    async function* source(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      await new Promise<never>(() => {});
    }

    const stream = translateResponseKimi(source())[Symbol.asyncIterator]();
    expect((await stream.next()).value).toEqual({
      kind: "message_stop",
      stop_reason: "stop",
    });

    const completion = await Promise.race([
      stream.next(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    expect(completion).not.toBeNull();
    expect(completion?.done).toBe(true);
  });
});
