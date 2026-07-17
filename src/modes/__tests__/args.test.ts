import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { registerRuntimeModel, resetRuntimeModelsForTests } from "@/engine/model/catalog.ts";
import { parseArgs, permissionModeToWire } from "@/modes/args.ts";

// parseArgs mirrors CLI flags into process.env; clean up after each case.
afterEach(() => {
  delete process.env.OTHERSIDE_FLAG_PLUGIN_DIRS;
  delete process.env.OTHERSIDE_CLI_SESSION_ID;
  delete process.env.OTHERSIDE_CLI_FORK_SESSION;
  delete process.env.OTHERSIDE_CLI_RESUME_ACTIVE;
  delete process.env.OTHERSIDE_CLI_ADD_DIRS;
  delete process.env.OTHERSIDE_CLI_INCLUDE_PARTIAL_MESSAGES;
  delete process.env.OTHERSIDE_CLI_SYSTEM_PROMPT;
  delete process.env.OTHERSIDE_CLI_APPEND_SYSTEM_PROMPT;
  delete process.env.OTHERSIDE_CLI_MAX_BUDGET_USD;
  delete process.env.OTHERSIDE_CLI_FALLBACK_MODEL;
  delete process.env.OTHERSIDE_CLI_MCP_CONFIGS;
  delete process.env.OTHERSIDE_CLI_AGENTS_JSON;
  delete process.env.OTHERSIDE_CLI_JSON_SCHEMA;
  resetRuntimeModelsForTests();
});

describe("--plugin-dir", () => {
  it("collects repeated --plugin-dir flags into the env (path-delimited)", () => {
    parseArgs(["bun", "cli", "-p", "hi", "--plugin-dir", "/a", "--plugin-dir", "/b"]);
    expect(process.env.OTHERSIDE_FLAG_PLUGIN_DIRS).toBe(`/a${delimiter}/b`);
  });

  it("supports the --plugin-dir=value form", () => {
    parseArgs(["bun", "cli", "-p", "hi", "--plugin-dir=/c"]);
    expect(process.env.OTHERSIDE_FLAG_PLUGIN_DIRS).toBe("/c");
  });

  it("leaves the env unset when no --plugin-dir is passed", () => {
    parseArgs(["bun", "cli", "-p", "hi"]);
    expect(process.env.OTHERSIDE_FLAG_PLUGIN_DIRS).toBeUndefined();
  });
});

describe("print-mode G7 flags", () => {
  it("parses --session-id as a UUID and mirrors it to the print env", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--session-id", id]);
    if (mode.kind !== "print") throw new Error("expected print");
    expect(mode.sessionId).toBe(id);
    expect(mode.prompt).toBe("hi");
    expect(process.env.OTHERSIDE_CLI_SESSION_ID).toBe(id);
  });

  it("rejects an invalid --session-id", () => {
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--session-id", "not-a-uuid"]);
    expect(mode.kind).toBe("error");
    if (mode.kind !== "error") throw new Error("expected error");
    expect(mode.message).toContain("invalid --session-id");
    expect(mode.code).toBe(1);
  });

  it("parses --fork-session without requiring --resume", () => {
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--fork-session"]);
    if (mode.kind !== "print") throw new Error("expected print");
    expect(mode.forkSession).toBe(true);
    expect(mode.resumeSessionId).toBeNull();
    expect(mode.resumeLatest).toBe(false);
    expect(process.env.OTHERSIDE_CLI_FORK_SESSION).toBe("1");
    expect(process.env.OTHERSIDE_CLI_RESUME_ACTIVE).toBeUndefined();
  });

  it("marks forked print resumes as resume-active", () => {
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--fork-session", "--resume", "old"]);
    if (mode.kind !== "print") throw new Error("expected print");
    expect(mode.forkSession).toBe(true);
    expect(mode.resumeSessionId).toBe("old");
    expect(process.env.OTHERSIDE_CLI_RESUME_ACTIVE).toBe("1");
  });

  it("accumulates repeated --add-dir values and skips them as prompt positionals", () => {
    const dirA = mkdtempSync(join(tmpdir(), "otherside-add-dir-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "otherside-add-dir-b-"));
    try {
      const mode = parseArgs(["bun", "cli", "-p", "hi", "--add-dir", dirA, `--add-dir=${dirB}`]);
      if (mode.kind !== "print") throw new Error("expected print");
      expect(mode.addDirs).toEqual([dirA, dirB]);
      expect(mode.prompt).toBe("hi");
      expect(process.env.OTHERSIDE_CLI_ADD_DIRS).toBe(JSON.stringify([dirA, dirB]));
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("parses inline and file --mcp-config values without swallowing the prompt", () => {
    const dir = mkdtempSync(join(tmpdir(), "otherside-mcp-config-"));
    try {
      const file = join(dir, "mcp.json");
      const secondFile = join(dir, "mcp-extra.json");
      writeFileSync(
        file,
        JSON.stringify({
          mcpServers: { fromFile: { type: "stdio", command: "server", args: [] } },
        }),
      );
      writeFileSync(
        secondFile,
        JSON.stringify({
          mcpServers: { extraFile: { type: "stdio", command: "server", args: [] } },
        }),
      );
      const inline = JSON.stringify({
        mcpServers: { inline: { type: "stdio", command: "server", args: [] } },
      });
      const mode = parseArgs([
        "bun",
        "cli",
        "-p",
        "hi",
        "--mcp-config",
        file,
        secondFile,
        `--mcp-config=${inline}`,
      ]);
      if (mode.kind !== "print") throw new Error("expected print");
      expect(mode.mcpConfigs).toEqual([file, secondFile, inline]);
      expect(mode.prompt).toBe("hi");
      expect(process.env.OTHERSIDE_CLI_MCP_CONFIGS).toBe(
        JSON.stringify([file, secondFile, inline]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid inline --mcp-config JSON", () => {
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--mcp-config", "{not-json"]);
    expect(mode.kind).toBe("error");
    if (mode.kind !== "error") throw new Error("expected error");
    expect(mode.message).toContain("invalid --mcp-config JSON");
  });

  it("parses --agents JSON and mirrors it to the print env", () => {
    const agents = JSON.stringify({
      helper: { description: "Helps", prompt: "Be helpful", tools: ["Read"] },
    });
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--agents", agents]);
    if (mode.kind !== "print") throw new Error("expected print");
    expect(mode.agentsJson).toBe(agents);
    expect(mode.prompt).toBe("hi");
    expect(process.env.OTHERSIDE_CLI_AGENTS_JSON).toBe(agents);
  });

  it("rejects invalid --agents JSON", () => {
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--agents", "{nope"]);
    expect(mode.kind).toBe("error");
    if (mode.kind !== "error") throw new Error("expected error");
    expect(mode.message).toContain("invalid --agents JSON");
  });

  it("parses inline --json-schema and mirrors it to the print env", () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--json-schema", JSON.stringify(schema)]);
    if (mode.kind !== "print") throw new Error("expected print");
    expect(mode.jsonSchema).toEqual(schema);
    expect(mode.prompt).toBe("hi");
    expect(process.env.OTHERSIDE_CLI_JSON_SCHEMA).toBe(JSON.stringify(schema));
  });

  it("parses file --json-schema and skips the path as a prompt positional", () => {
    const dir = mkdtempSync(join(tmpdir(), "otherside-json-schema-"));
    try {
      const schema = {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      };
      const file = join(dir, "schema.json");
      writeFileSync(file, JSON.stringify(schema));
      const mode = parseArgs(["bun", "cli", "-p", "hi", "--json-schema", file]);
      if (mode.kind !== "print") throw new Error("expected print");
      expect(mode.jsonSchema).toEqual(schema);
      expect(mode.prompt).toBe("hi");
      expect(process.env.OTHERSIDE_CLI_JSON_SCHEMA).toBe(JSON.stringify(schema));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid --json-schema JSON", () => {
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--json-schema", "{nope"]);
    expect(mode.kind).toBe("error");
    if (mode.kind !== "error") throw new Error("expected error");
    expect(mode.message).toContain("invalid --json-schema JSON");
    expect(process.env.OTHERSIDE_CLI_JSON_SCHEMA).toBeUndefined();
  });
});

describe("print-mode positional prompt", () => {
  it("does not mistake a value-flag value for the prompt", () => {
    const mode = parseArgs(["bun", "cli", "-p", "--output-format", "json"]);
    expect(mode.kind).toBe("print");
    if (mode.kind !== "print") throw new Error("expected print");
    expect(mode.prompt).toBe("");
    expect(mode.outputFormat).toBe("json");
  });

  it("joins multiple positional tokens and skips flag values", () => {
    const mode = parseArgs(["bun", "cli", "-p", "--model", "sonnet", "hello", "world"]);
    if (mode.kind !== "print") throw new Error("expected print");
    expect(mode.prompt).toBe("hello world");
    expect(mode.model).toBe("sonnet");
  });

  it("keeps the prompt distinct from a --resume id", () => {
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--resume", "abc123"]);
    if (mode.kind !== "print") throw new Error("expected print");
    expect(mode.prompt).toBe("hi");
    expect(mode.resumeSessionId).toBe("abc123");
    expect(mode.resumeLatest).toBe(false);
  });

  it("parses -c / --continue as resume-latest in print mode", () => {
    const mode = parseArgs(["bun", "cli", "-p", "hi", "-c"]);
    if (mode.kind !== "print") throw new Error("expected print");
    expect(mode.resumeLatest).toBe(true);
  });

  it("honors the -- separator for a prompt with leading dashes", () => {
    const mode = parseArgs(["bun", "cli", "-p", "--", "--not-a-flag", "text"]);
    if (mode.kind !== "print") throw new Error("expected print");
    expect(mode.prompt).toBe("--not-a-flag text");
  });

  it("parses --max-turns as a positive int without swallowing the prompt", () => {
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--max-turns", "3"]);
    if (mode.kind !== "print") throw new Error("expected print");
    expect(mode.maxTurns).toBe(3);
    expect(mode.prompt).toBe("hi");
  });

  it("ignores a non-positive --max-turns", () => {
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--max-turns", "0"]);
    if (mode.kind !== "print") throw new Error("expected print");
    expect(mode.maxTurns).toBeNull();
  });

  it("parses --include-partial-messages as a value-less print flag", () => {
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--include-partial-messages"]);
    if (mode.kind !== "print") throw new Error("expected print");
    expect(mode.prompt).toBe("hi");
    expect(mode.includePartialMessages).toBe(true);
    expect(process.env.OTHERSIDE_CLI_INCLUDE_PARTIAL_MESSAGES).toBe("1");
  });

  it("parses system prompt flags without swallowing the prompt", () => {
    const mode = parseArgs([
      "bun",
      "cli",
      "-p",
      "hi",
      "--system-prompt",
      "replace me",
      "--append-system-prompt",
      "append me",
    ]);
    if (mode.kind !== "print") throw new Error("expected print");
    expect(mode.prompt).toBe("hi");
    expect(mode.systemPrompt).toBe("replace me");
    expect(mode.appendSystemPrompt).toBe("append me");
    expect(process.env.OTHERSIDE_CLI_SYSTEM_PROMPT).toBe("replace me");
    expect(process.env.OTHERSIDE_CLI_APPEND_SYSTEM_PROMPT).toBe("append me");
  });

  it("parses --max-budget-usd as a non-negative number", () => {
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--max-budget-usd", "0.25"]);
    if (mode.kind !== "print") throw new Error("expected print");
    expect(mode.maxBudgetUsd).toBe(0.25);
    expect(mode.prompt).toBe("hi");
    expect(process.env.OTHERSIDE_CLI_MAX_BUDGET_USD).toBe("0.25");
  });

  it("rejects an invalid --max-budget-usd", () => {
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--max-budget-usd", "nope"]);
    expect(mode.kind).toBe("error");
    if (mode.kind !== "error") throw new Error("expected error");
    expect(mode.message).toContain("invalid --max-budget-usd");
  });

  it("validates and mirrors --fallback-model", () => {
    registerRuntimeModel({
      id: "known-fallback-model",
      displayName: "Known fallback model",
      contextWindow: 1000,
      provider: "anthropic",
      efforts: [],
      defaultEffort: null,
    });
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--fallback-model", "known-fallback-model"]);
    if (mode.kind !== "print") throw new Error("expected print");
    expect(mode.fallbackModel).toBe("known-fallback-model");
    expect(mode.prompt).toBe("hi");
    expect(process.env.OTHERSIDE_CLI_FALLBACK_MODEL).toBe("known-fallback-model");
  });

  it("rejects an unknown --fallback-model", () => {
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--fallback-model", "missing-model"]);
    expect(mode.kind).toBe("error");
    if (mode.kind !== "error") throw new Error("expected error");
    expect(mode.message).toContain("invalid --fallback-model");
  });
});

describe("permission-mode validation", () => {
  it("errors (exit 1) on an unrecognized --permission-mode value", () => {
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--permission-mode", "garbage"]);
    expect(mode.kind).toBe("error");
    if (mode.kind !== "error") throw new Error("expected error");
    expect(mode.code).toBe(1);
  });

  it("accepts a valid camelCase --permission-mode", () => {
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--permission-mode", "acceptEdits"]);
    if (mode.kind !== "print") throw new Error("expected print");
    expect(mode.permissionMode).toBe("accept-edits");
  });
});

describe("--worktree flag", () => {
  it("parses --worktree with a name in print mode", () => {
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--worktree", "my-feature"]);
    if (mode.kind !== "print") throw new Error("expected print");
    expect(mode.worktree).toEqual({ name: "my-feature" });
    expect(mode.prompt).toBe("hi");
  });

  it("parses a bare --worktree (auto name) without eating the next flag", () => {
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--worktree", "--verbose"]);
    if (mode.kind !== "print") throw new Error("expected print");
    expect(mode.worktree).toEqual({ name: null });
    expect(mode.verbose).toBe(true);
    expect(mode.prompt).toBe("hi");
  });

  it("parses --worktree=name and the -w short form", () => {
    const eq = parseArgs(["bun", "cli", "-p", "hi", "--worktree=fix-bug"]);
    if (eq.kind !== "print") throw new Error("expected print");
    expect(eq.worktree).toEqual({ name: "fix-bug" });

    const short = parseArgs(["bun", "cli", "-p", "hi", "-w", "fix-bug"]);
    if (short.kind !== "print") throw new Error("expected print");
    expect(short.worktree).toEqual({ name: "fix-bug" });
  });

  it("keeps worktree null when the flag is absent", () => {
    const mode = parseArgs(["bun", "cli", "-p", "hi"]);
    if (mode.kind !== "print") throw new Error("expected print");
    expect(mode.worktree).toBeNull();
  });

  it("carries the flag on interactive resume launches", () => {
    const mode = parseArgs(["bun", "cli", "--resume", "abc", "--worktree", "my-feature"]);
    if (mode.kind !== "interactive") throw new Error("expected interactive");
    expect(mode.worktree).toEqual({ name: "my-feature" });
  });

  it("carries a PR-reference value verbatim for the launch layer to resolve", () => {
    const mode = parseArgs(["bun", "cli", "-p", "hi", "--worktree", "#123"]);
    if (mode.kind !== "print") throw new Error("expected print");
    expect(mode.worktree).toEqual({ name: "#123" });
  });
});

describe("--tmux flag", () => {
  it("parses --tmux alongside --worktree in both modes", () => {
    const print = parseArgs(["bun", "cli", "-p", "hi", "--worktree", "x", "--tmux"]);
    if (print.kind !== "print") throw new Error("expected print");
    expect(print.tmux).toBe(true);
    expect(print.prompt).toBe("hi");

    const interactive = parseArgs(["bun", "cli", "--resume", "abc", "--worktree", "--tmux"]);
    if (interactive.kind !== "interactive") throw new Error("expected interactive");
    expect(interactive.tmux).toBe(true);
    expect(interactive.worktree).toEqual({ name: null });
  });

  it("accepts the --tmux=classic spelling and defaults to false", () => {
    const classic = parseArgs(["bun", "cli", "-p", "hi", "--worktree", "x", "--tmux=classic"]);
    if (classic.kind !== "print") throw new Error("expected print");
    expect(classic.tmux).toBe(true);

    const off = parseArgs(["bun", "cli", "-p", "hi", "--worktree", "x"]);
    if (off.kind !== "print") throw new Error("expected print");
    expect(off.tmux).toBe(false);
  });
});

describe("permissionModeToWire", () => {
  it("maps internal modes to their camelCase wire values", () => {
    expect(permissionModeToWire("default")).toBe("default");
    expect(permissionModeToWire("accept-edits")).toBe("acceptEdits");
    expect(permissionModeToWire("plan")).toBe("plan");
    expect(permissionModeToWire("yolo")).toBe("bypassPermissions");
  });
});
