import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fsModule from "node:fs";
import * as realConfig from "@/kernel/config/config.ts";
import * as realEnv from "@/kernel/std/proc/env.ts";
import type { TerminalProgressSequenceBuilder } from "@/kernel/std/terminal-progress.ts";

const originalFs: Record<string | symbol, unknown> = {};
for (const key of Reflect.ownKeys(fsModule)) {
  originalFs[key] = (fsModule as Record<string | symbol, unknown>)[key];
}

const originalConfig: Record<string | symbol, unknown> = {};
for (const key of Reflect.ownKeys(realConfig)) {
  originalConfig[key] = (realConfig as Record<string | symbol, unknown>)[key];
}

const originalEnv: Record<string | symbol, unknown> = {};
for (const key of Reflect.ownKeys(realEnv)) {
  originalEnv[key] = (realEnv as Record<string | symbol, unknown>)[key];
}

const realLoadConfigSync = realConfig.loadConfigSync;
const fakeBuildSequence: TerminalProgressSequenceBuilder = (state) => `SEQ:${state}`;

const written: Buffer[] = [];
let mockTerminal: string | undefined = "iTerm.app";
let mockEnabled: boolean | undefined = true;

async function unsetTerminalProgressSequenceBuilder(): Promise<void> {
  const { setTerminalProgressSequenceBuilder } = await import("@/kernel/std/terminal-progress.ts");
  (setTerminalProgressSequenceBuilder as unknown as (build: null) => void)(null);
}

beforeEach(() => {
  written.length = 0;
  mockTerminal = "iTerm.app";
  mockEnabled = true;
  const envRef = realEnv;
  mock.module("@/kernel/std/proc/env.ts", () => {
    const proxy = new Proxy(envRef.env, {
      get(target, prop: string) {
        if (prop === "terminal") return mockTerminal;
        return target[prop as keyof typeof target];
      },
    });
    return { ...envRef, env: proxy };
  });
  mock.module("@/kernel/config/config.ts", () => ({
    ...realConfig,
    loadConfigSync: () => ({
      ...realLoadConfigSync(),
      terminalProgressBarEnabled: mockEnabled,
    }),
  }));
  mock.module("node:fs", () => ({
    writeSync: (_fd: number, data: Buffer | string) => {
      written.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
      return data.length;
    },
  }));
});

beforeEach(async () => {
  await unsetTerminalProgressSequenceBuilder();
});

afterEach(() => {
  mock.restore();
});

afterAll(() => {
  mock.module("@/kernel/std/proc/env.ts", () => originalEnv);
  mock.module("@/kernel/config/config.ts", () => originalConfig);
  mock.module("node:fs", () => originalFs);
});

describe("isTerminalProgressSupported", () => {
  test.each(["iTerm.app", "WezTerm", "vscode"])("supports %s", async (term) => {
    mockTerminal = term;
    const { isTerminalProgressSupported } = await import("@/kernel/std/terminal-progress.ts");
    expect(isTerminalProgressSupported()).toBe(true);
  });

  test.each(["Apple_Terminal", "kitty", "ghostty", undefined])("rejects %s", async (term) => {
    mockTerminal = term;
    const { isTerminalProgressSupported } = await import("@/kernel/std/terminal-progress.ts");
    expect(isTerminalProgressSupported()).toBe(false);
  });
});

describe("emitTerminalProgress", () => {
  beforeEach(async () => {
    const { setTerminalProgressSequenceBuilder } = await import(
      "@/kernel/std/terminal-progress.ts"
    );
    setTerminalProgressSequenceBuilder(fakeBuildSequence);
  });

  test("does not write when the sequence builder is unset", async () => {
    await unsetTerminalProgressSequenceBuilder();
    const { emitTerminalProgress } = await import("@/kernel/std/terminal-progress.ts");
    emitTerminalProgress("indeterminate");
    expect(written.length).toBe(0);
  });

  test("indeterminate emits the injected sequence", async () => {
    mockTerminal = "iTerm.app";
    const { emitTerminalProgress } = await import("@/kernel/std/terminal-progress.ts");
    emitTerminalProgress("indeterminate");
    expect(Buffer.concat(written).toString()).toBe("SEQ:indeterminate");
  });

  test("completed emits the injected sequence", async () => {
    mockTerminal = "iTerm.app";
    const { emitTerminalProgress } = await import("@/kernel/std/terminal-progress.ts");
    emitTerminalProgress("completed");
    expect(Buffer.concat(written).toString()).toBe("SEQ:completed");
  });

  test("error emits the injected sequence", async () => {
    mockTerminal = "iTerm.app";
    const { emitTerminalProgress } = await import("@/kernel/std/terminal-progress.ts");
    emitTerminalProgress("error");
    expect(Buffer.concat(written).toString()).toBe("SEQ:error");
  });

  test("no-op on Apple_Terminal (terminal unsupported)", async () => {
    mockTerminal = "Apple_Terminal";
    const { emitTerminalProgress } = await import("@/kernel/std/terminal-progress.ts");
    emitTerminalProgress("indeterminate");
    expect(written.length).toBe(0);
  });

  test("respects disabled setting", async () => {
    mockTerminal = "iTerm.app";
    mockEnabled = false;
    const { emitTerminalProgress } = await import("@/kernel/std/terminal-progress.ts");
    emitTerminalProgress("indeterminate");
    expect(written.length).toBe(0);
  });

  test("defaults to enabled when setting is undefined", async () => {
    mockTerminal = "iTerm.app";
    mockEnabled = undefined;
    const { emitTerminalProgress } = await import("@/kernel/std/terminal-progress.ts");
    emitTerminalProgress("indeterminate");
    expect(written.length).toBe(1);
    expect(Buffer.concat(written).toString()).toBe("SEQ:indeterminate");
  });
});
