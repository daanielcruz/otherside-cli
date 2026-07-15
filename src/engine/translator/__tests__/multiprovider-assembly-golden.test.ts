import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetWireLatchesForTests } from "@/engine/providers/anthropic/_infra/wire-latches.ts";
import { applyCchAttestation } from "@/engine/providers/anthropic/cch.ts";
import * as providers from "@/engine/providers/registry.ts";
import { registerAllBuiltins } from "@/engine/tools/register-builtins.ts";
import { assembleProviderTurn, type ProviderToolDeclaration } from "@/engine/translator/index.ts";
import { makeQueue } from "@/harness/composer/queue.ts";
import { _setEnvInfoOverrideForTesting } from "@/harness/core/env-info.ts";
import { _setMemoryDirOverrideForTesting } from "@/harness/core/memory-guidance/memory-guidance.ts";
import { DEFAULT_CONFIG } from "@/kernel/config/config.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

let scratchDir: string | undefined;
let priorCwd: string;
let priorConfigDir: string | undefined;
let priorScratchpadDir: string | undefined;

beforeEach(() => {
  priorCwd = process.cwd();
  priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  priorScratchpadDir = process.env.OTHERSIDE_SCRATCHPAD_DIR;
  process.env.OTHERSIDE_SCRATCHPAD_DIR = "/tmp/otherside-fixture/scratchpad";
  _setEnvInfoOverrideForTesting({
    workspaceDir: "/workspace/project",
    isGitRepo: false,
    platform: "darwin",
    osVersion: "Darwin 0.0.0",
    shell: "bash",
  });
  _setMemoryDirOverrideForTesting("/workspace/fixture/memory");
  registerAllBuiltins();

  const baseDir = priorConfigDir || tmpdir();
  scratchDir = mkdtempSync(join(baseDir, "otherside-b09-scratch-"));
  process.env.OTHERSIDE_CONFIG_DIR = scratchDir;

  const fakeCredentials = {
    anthropic: {
      accessToken: "fake-anthropic-token",
      refreshToken: "fake-anthropic-refresh",
      expiresAt: 1_800_000_000_000,
      accountUuid: "acct-fixture",
    },
    codex: {
      accessToken: "fake-codex-token",
      refreshToken: "fake-codex-refresh",
      expiresAt: 1_800_000_000_000,
      accountId: "codex-account-fixture",
    },
    antigravity: {
      accessToken: "fake-antigravity-token",
      refreshToken: "fake-antigravity-refresh",
      expiresAt: 1_800_000_000_000,
    },
    glm: {
      zcodeJwtToken: "fake-glm-zcode-token",
      zaiAccessToken: "fake-glm-zai-token",
      expiresAt: 1_800_000_000_000,
      user: {
        user_id: "glm-user-fixture",
      },
    },
  };
  writeFileSync(join(scratchDir, "credentials.json"), JSON.stringify(fakeCredentials));
});

afterEach(() => {
  _setEnvInfoOverrideForTesting(null);
  _setMemoryDirOverrideForTesting(null);
  process.chdir(priorCwd);
  if (priorScratchpadDir === undefined) {
    delete process.env.OTHERSIDE_SCRATCHPAD_DIR;
  } else {
    process.env.OTHERSIDE_SCRATCHPAD_DIR = priorScratchpadDir;
  }
  if (priorConfigDir === undefined) {
    delete process.env.OTHERSIDE_CONFIG_DIR;
  } else {
    process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;
  }
  if (scratchDir !== undefined) {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {}
    scratchDir = undefined;
  }
});

function runInTempCwd<T>(scratchDir: string, fn: (tempCwd: string) => T): T {
  const tempCwd = mkdtempSync(join(scratchDir, "cwd-empty-"));
  const originalCwd = process.cwd();
  try {
    process.chdir(tempCwd);
    return fn(tempCwd);
  } finally {
    process.chdir(originalCwd);
    try {
      rmSync(tempCwd, { recursive: true, force: true });
    } catch {}
  }
}

function pinMetadata(body: Record<string, unknown>, sessionId: string): void {
  body.metadata = {
    user_id: JSON.stringify({
      device_id: "0".repeat(64),
      account_uuid: "acct-fixture",
      session_id: sessionId,
    }),
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function cleanPaths(val: unknown, scratchDir: string, tempCwd: string): unknown {
  if (typeof val === "string") {
    let cleaned = val;
    cleaned = cleaned.replaceAll(tempCwd, "<test-dir>");
    cleaned = cleaned.replaceAll(scratchDir, "<test-dir>");
    return cleaned;
  }
  if (Array.isArray(val)) {
    return val.map((item) => cleanPaths(item, scratchDir, tempCwd));
  }
  if (val !== null && typeof val === "object") {
    const res: Record<string, unknown> = {};
    for (const key of Object.keys(val)) {
      res[key] = cleanPaths((val as Record<string, unknown>)[key], scratchDir, tempCwd);
    }
    return res;
  }
  return val;
}

interface ComposedHarnessMini {
  systemBlocks: unknown;
  userPrepend: unknown;
  midSystemBlocks?: unknown;
}

function makeSnapshotObject(
  mode: "OFF" | "ON",
  wire: string,
  tools: ProviderToolDeclaration[],
  harness: ComposedHarnessMini,
  scratchDir: string,
  tempCwd: string,
) {
  const agentDeclaration = tools.find((t) => t.name === "Agent");
  const workflowDeclaration = tools.find((t) => t.name === "Workflow");

  return cleanPaths(
    {
      mode,
      bodyHash: sha256(wire),
      body: JSON.parse(wire),
      toolNames: tools.map((t) => t.name),
      agentDeclaration,
      workflowDeclaration,
      harness: {
        systemBlocks: harness.systemBlocks,
        userPrepend: harness.userPrepend,
        midSystemBlocks: harness.midSystemBlocks,
      },
    },
    scratchDir,
    tempCwd,
  );
}

const ctx: RequestContext = {
  provider: "anthropic",
  model: "claude-opus-4-8",
  effort: "high",
  permissionMode: "default",
  sessionId: "sess-fixture-00000000-0000-0000-0000-000000000000",
  cwd: "/workspace/fixture",
  agentic: true,
};

const messages: Message[] = [
  { role: "user", content: [{ type: "text", text: "explain the build" }] },
];

const currentDate = "2026-07-12";
const gitStatus = "On branch main";

describe("multiprovider assembly goldens", () => {
  const provider = providers.get("anthropic");

  it("orchestratorMode: off, tierSelectorEnabled: false (OFF)", () => {
    const configOff = {
      ...DEFAULT_CONFIG,
      orchestratorMode: "off" as const,
      tierSelectorEnabled: false,
    };

    runInTempCwd(scratchDir!, (tempCwd) => {
      function runAssembly() {
        _resetWireLatchesForTests();
        const injections = makeQueue();
        const turn = assembleProviderTurn({
          ctx,
          provider,
          messages,
          injections,
          config: configOff,
          currentDate,
          gitStatus,
        });
        const body = provider.translateRequest(ctx, turn.messages, turn.tools) as Record<
          string,
          unknown
        >;
        pinMetadata(body, ctx.sessionId);
        const wire = applyCchAttestation(JSON.stringify(body));
        return { turn, body, wire };
      }

      const { turn: turn1, body: body1, wire: wire1 } = runAssembly();
      const { wire: wire2 } = runAssembly();
      expect(wire1).toBe(wire2);

      const agentTool = turn1.tools.find((t) => t.name === "Agent");
      expect(agentTool).toBeDefined();
      const agentProps = (agentTool!.input_schema as { properties?: Record<string, unknown> })
        .properties;
      expect(agentProps?.provider).toBeUndefined();
      expect(agentProps?.tier).toBeUndefined();

      expect(agentTool!.description).not.toContain("Multi-provider orchestration");
      expect(agentTool!.description).not.toContain("general — the strategist and commander");

      const bodyStr = JSON.stringify(body1);
      expect(bodyStr).not.toContain("Multi-provider orchestration");

      const snapshotObj = makeSnapshotObject(
        "OFF",
        wire1,
        turn1.tools,
        turn1.harness,
        scratchDir!,
        tempCwd,
      );
      expect(snapshotObj).toMatchSnapshot();
    });
  });

  it("orchestratorMode: soft, tierSelectorEnabled: true (ON)", () => {
    const configOn = {
      ...DEFAULT_CONFIG,
      orchestratorMode: "soft" as const,
      tierSelectorEnabled: true,
    };

    runInTempCwd(scratchDir!, (tempCwd) => {
      function runAssembly() {
        _resetWireLatchesForTests();
        const injections = makeQueue();
        const turn = assembleProviderTurn({
          ctx,
          provider,
          messages,
          injections,
          config: configOn,
          currentDate,
          gitStatus,
        });
        const body = provider.translateRequest(ctx, turn.messages, turn.tools) as Record<
          string,
          unknown
        >;
        pinMetadata(body, ctx.sessionId);
        const wire = applyCchAttestation(JSON.stringify(body));
        return { turn, body, wire };
      }

      const { turn: turn1, body: body1, wire: wire1 } = runAssembly();
      const { wire: wire2 } = runAssembly();
      expect(wire1).toBe(wire2);

      const agentTool = turn1.tools.find((t) => t.name === "Agent");
      expect(agentTool).toBeDefined();
      const agentProps = (agentTool!.input_schema as { properties?: Record<string, unknown> })
        .properties;
      expect(agentProps?.provider).toBeDefined();
      expect(agentProps?.tier).toBeDefined();
      expect(agentProps?.model).toBeDefined();

      expect(agentTool!.description).toContain("Multi-provider orchestration");
      expect(agentTool!.description).toContain("general — the strategist and commander");

      const bodyStr = JSON.stringify(body1);
      expect(bodyStr).toContain("Multi-provider orchestration");

      const snapshotObj = makeSnapshotObject(
        "ON",
        wire1,
        turn1.tools,
        turn1.harness,
        scratchDir!,
        tempCwd,
      );
      expect(snapshotObj).toMatchSnapshot();
    });
  });
});
