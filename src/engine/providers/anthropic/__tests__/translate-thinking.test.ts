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
import { buildAnthropicMessages } from "@/engine/providers/anthropic/translate.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const SIGNATURE = "A".repeat(420);
const CURRENT_ACCOUNT = "acct-current-uuid";

let scratchRoot: string;
let priorConfigDir: string | undefined;

function useConfigDir(name: string, credentials: unknown): void {
  const dir = join(scratchRoot, name);
  if (credentials !== null) {
    writeFileFn(join(dir, "credentials.json"), JSON.stringify(credentials));
  }
  process.env.OTHERSIDE_CONFIG_DIR = dir;
}

beforeAll(() => {
  scratchRoot = mkdtempFn("account-gate-");
  priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  useConfigDir("with-account", {
    anthropic: { accessToken: "t", refreshToken: "r", expiresAt: 0, accountUuid: CURRENT_ACCOUNT },
  });
});

afterAll(() => {
  if (priorConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;

  mock.module("node:fs", () => originalFs);
});

const ctx = {
  provider: "anthropic",
  model: "claude-fable-5",
  effort: "high",
  permissionMode: "default",
  sessionId: "test",
  cwd: "/tmp",
} as unknown as RequestContext;

function conversationWith(assistant: Partial<Message>): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      producedBy: "anthropic",
      producedModel: "claude-fable-5",
      content: [
        { type: "thinking", text: "t", signature: SIGNATURE },
        { type: "text", text: "ok" },
      ],
      ...assistant,
    },
    { role: "user", content: [{ type: "text", text: "next" }] },
  ];
}

function thinkingBlocksOnWire(messages: Message[]): number {
  return buildAnthropicMessages(messages, ctx)
    .out.flatMap((m) => m.content)
    .filter((b) => b.type === "thinking").length;
}

describe("account-bound thinking replay", () => {
  it("drops thinking stamped by another account", () => {
    expect(thinkingBlocksOnWire(conversationWith({ producedAccount: "other-account" }))).toBe(0);
  });

  it("keeps same-account thinking, even cross-model", () => {
    expect(thinkingBlocksOnWire(conversationWith({ producedAccount: CURRENT_ACCOUNT }))).toBe(1);
    expect(
      thinkingBlocksOnWire(
        conversationWith({ producedAccount: CURRENT_ACCOUNT, producedModel: "claude-opus-4-8" }),
      ),
    ).toBe(1);
  });

  it("drops unstamped (legacy) thinking when the current account is known", () => {
    expect(thinkingBlocksOnWire(conversationWith({}))).toBe(0);
  });

  it("drops thinking produced by a non-anthropic provider", () => {
    expect(
      thinkingBlocksOnWire(conversationWith({ producedBy: "antigravity", producedAccount: "any" })),
    ).toBe(0);
  });

  it("keeps the assistant message body when its thinking drops", () => {
    const { out } = buildAnthropicMessages(conversationWith({}), ctx);
    const assistant = out.find((m) => m.role === "assistant");
    expect(assistant?.content.some((b) => b.type === "text")).toBe(true);
    expect(assistant?.content.some((b) => b.type === "thinking")).toBe(false);
  });

  it("keeps unstamped thinking when the current account is also unknown", () => {
    useConfigDir("no-account", null);
    try {
      expect(thinkingBlocksOnWire(conversationWith({}))).toBe(1);
      expect(thinkingBlocksOnWire(conversationWith({ producedAccount: "other" }))).toBe(0);
    } finally {
      useConfigDir("with-account", {
        anthropic: {
          accessToken: "t",
          refreshToken: "r",
          expiresAt: 0,
          accountUuid: CURRENT_ACCOUNT,
        },
      });
    }
  });
});
