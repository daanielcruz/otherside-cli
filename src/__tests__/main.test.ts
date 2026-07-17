import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { CredentialsBundle } from "@/kernel/storage/credentials.ts";
import type { CliMode } from "@/modes/args.ts";
import { formatDirectResumeError, resolveStartupBroker } from "../main.ts";

const savedResumeProvider = process.env.OTHERSIDE_DEVTOOLS_RESUME_PROVIDER;
const savedResumeModel = process.env.OTHERSIDE_DEVTOOLS_RESUME_MODEL;

afterEach(() => {
  restoreEnv("OTHERSIDE_DEVTOOLS_RESUME_PROVIDER", savedResumeProvider);
  restoreEnv("OTHERSIDE_DEVTOOLS_RESUME_MODEL", savedResumeModel);
});

describe("resolveStartupBroker fresh-session default", () => {
  beforeAll(() => {
    registerAllProviders();
  });

  const baseCfg: UserConfig = {
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-8",
  } as unknown as UserConfig;

  const dummyAllCreds: CredentialsBundle = {
    anthropic: {
      accessToken: "dummy-token",
      refreshToken: "dummy-refresh",
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
  };

  const interactiveMode: Extract<CliMode, { kind: "interactive" }> = {
    kind: "interactive",
    yolo: false,
    permissionMode: null,
    resumeSessionId: null,
    resumeLatest: false,
    provider: null,
    model: null,
    worktree: null,
    tmux: false,
  };

  const printMode: Extract<CliMode, { kind: "print" }> = {
    kind: "print",
    prompt: "hi",
    yolo: false,
    permissionMode: null,
    outputFormat: "text",
    verbose: false,
    model: null,
    effort: null,
    provider: null,
    resumeSessionId: null,
    resumeLatest: false,
    maxTurns: null,
    worktree: null,
    tmux: false,
  };

  it("defaults headless (print) to the 'default' permission mode", () => {
    const result = resolveStartupBroker({
      mode: printMode,
      cfg: baseCfg,
      allCreds: dummyAllCreds,
      customCreds: null,
      resumeRecords: [],
      isResume: false,
    });
    expect(result.broker.read().permissionMode).toBe("default");
  });

  it("keeps interactive on accept-edits by default", () => {
    const result = resolveStartupBroker({
      mode: interactiveMode,
      cfg: baseCfg,
      allCreds: dummyAllCreds,
      customCreds: null,
      resumeRecords: [],
      isResume: false,
    });
    expect(result.broker.read().permissionMode).toBe("accept-edits");
  });

  it("inherits cfg.effortLevel when set", () => {
    const cfgWithEffort = {
      ...baseCfg,
      effortLevel: "medium" as const,
    } as unknown as UserConfig;

    const result = resolveStartupBroker({
      mode: interactiveMode,
      cfg: cfgWithEffort,
      allCreds: dummyAllCreds,
      customCreds: null,
      resumeRecords: [],
      isResume: false,
    });

    expect(result.broker.read().effort).toBe("medium");
  });

  it("falls back to old behavior (model default) when cfg.effortLevel is unset", () => {
    const cfgWithoutEffort = {
      ...baseCfg,
      effortLevel: undefined,
    } as unknown as UserConfig;

    const result = resolveStartupBroker({
      mode: interactiveMode,
      cfg: cfgWithoutEffort,
      allCreds: dummyAllCreds,
      customCreds: null,
      resumeRecords: [],
      isResume: false,
    });

    // defaultEffort for claude-opus-4-8 is xhigh
    expect(result.broker.read().effort).toBe("xhigh");
  });

  it("treats legacy GLM apiKey as missing credentials", () => {
    const cfgWithGlm = {
      ...baseCfg,
      defaultProvider: "glm",
      defaultModel: "glm-5.2",
    } as unknown as UserConfig;

    const result = resolveStartupBroker({
      mode: { ...interactiveMode, provider: "glm" },
      cfg: cfgWithGlm,
      allCreds: { glm: { apiKey: "legacy-key" } },
      customCreds: null,
      resumeRecords: [],
      isResume: false,
    });

    expect(result.cliProviderMissingCreds).toBe(true);
  });

  it("resolves a bare family shorthand passed via --model to its catalog id", () => {
    const result = resolveStartupBroker({
      mode: { ...interactiveMode, model: "sonnet" },
      cfg: baseCfg,
      allCreds: dummyAllCreds,
      customCreds: null,
      resumeRecords: [],
      isResume: false,
    });
    expect(result.initialProvider).toBe("anthropic");
    expect(result.initialModel).toBe("claude-sonnet-5");
  });

  it("applies resume provider overrides only when devtools explicitly enables them", () => {
    delete process.env.OTHERSIDE_DEVTOOLS_RESUME_PROVIDER;
    delete process.env.OTHERSIDE_DEVTOOLS_RESUME_MODEL;
    const resumeRecords = [
      {
        type: "session_meta",
        ts: "2026-07-14T00:00:00.000Z",
        cwd: "/repo",
        provider: "anthropic",
        model: "claude-opus-4-8",
        effort: "xhigh",
        fastMode: false,
      },
    ] as Parameters<typeof resolveStartupBroker>[0]["resumeRecords"];
    const mode = {
      ...interactiveMode,
      provider: "codex",
      model: "gpt-5.6-luna",
    } as Extract<CliMode, { kind: "interactive" }>;

    const persisted = resolveStartupBroker({
      mode,
      cfg: baseCfg,
      allCreds: dummyAllCreds,
      customCreds: null,
      resumeRecords,
      isResume: true,
    });
    expect(persisted.initialProvider).toBe("anthropic");
    expect(persisted.initialModel).toBe("claude-opus-4-8");

    process.env.OTHERSIDE_DEVTOOLS_RESUME_PROVIDER = "codex";
    process.env.OTHERSIDE_DEVTOOLS_RESUME_MODEL = "gpt-5.6-luna";
    const forced = resolveStartupBroker({
      mode,
      cfg: baseCfg,
      allCreds: dummyAllCreds,
      customCreds: null,
      resumeRecords,
      isResume: true,
    });
    expect(forced.initialProvider).toBe("codex");
    expect(forced.initialModel).toBe("gpt-5.6-luna");
    expect(forced.broker.read().provider).toBe("codex");
  });

  it("yolo wins over an explicit --permission-mode (bypass-first)", () => {
    // Reproduces: otherside -p 'write a file' --permission-mode plan --dangerously-skip-permissions
    const result = resolveStartupBroker({
      mode: { ...printMode, yolo: true, permissionMode: "plan" },
      cfg: baseCfg,
      allCreds: dummyAllCreds,
      customCreds: null,
      resumeRecords: [],
      isResume: false,
    });
    expect(result.broker.read().permissionMode).toBe("yolo");
  });

  it("still honors an explicit --permission-mode when yolo is not set", () => {
    const result = resolveStartupBroker({
      mode: { ...printMode, yolo: false, permissionMode: "plan" },
      cfg: baseCfg,
      allCreds: dummyAllCreds,
      customCreds: null,
      resumeRecords: [],
      isResume: false,
    });
    expect(result.broker.read().permissionMode).toBe("plan");
  });

  it("accepts GLM zcodeJwtToken as credentials", () => {
    const cfgWithGlm = {
      ...baseCfg,
      defaultProvider: "glm",
      defaultModel: "glm-5.2",
    } as unknown as UserConfig;

    const result = resolveStartupBroker({
      mode: { ...interactiveMode, provider: "glm" },
      cfg: cfgWithGlm,
      allCreds: { glm: { zcodeJwtToken: "jwt-token" } },
      customCreds: null,
      resumeRecords: [],
      isResume: false,
    });

    expect(result.cliProviderMissingCreds).toBe(false);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("direct resume errors", () => {
  it("formats loader failures as red terminal output without a fatal prefix", () => {
    expect(
      formatDirectResumeError(new Error("No conversation found with session ID: missing")),
    ).toBe("\u001b[31mNo conversation found with session ID: missing\u001b[39m\n");
    expect(
      formatDirectResumeError(
        new Error("This session belongs to a different directory. Open /repo to resume it."),
      ),
    ).toBe(
      "\u001b[31mThis session belongs to a different directory. Open /repo to resume it.\u001b[39m\n",
    );
  });
});
