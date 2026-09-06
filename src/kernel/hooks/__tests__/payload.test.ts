import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventCtx } from "@/kernel/hooks/events.ts";
import type { ToolCall } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { envFor } from "../events.ts";
import { fireEntry } from "../exec.ts";
import { handlersFromHookMap } from "../handler.ts";
import { payloadFor } from "../payload.ts";

describe("stdin JSON payload", () => {
  test("carries the event kind plus every field the env surface exposes", () => {
    const ev = {
      kind: "postToolUse",
      ctx: { toolName: "Bash", toolInput: '{"command":"ls"}', toolExit: 0 },
    } as const;

    const payload = payloadFor(ev);

    expect(payload.hook_event_name).toBe("PostToolUse");
    for (const key of Object.keys(envFor(ev))) {
      expect(payload).toHaveProperty(key.toLowerCase());
    }
    expect(payload.tool_name).toBe("Bash");
    expect(payload.tool_input).toEqual({ command: "ls" });
    // tool_exit is the real number, not the env string.
    expect(payload.tool_exit).toBe(0);
  });

  test("includes session id, transcript path and cwd when the call site has them", () => {
    expect(
      payloadFor({
        kind: "preCompact",
        ctx: { sessionId: "sess-1", transcriptPath: "/tmp/t.jsonl", trigger: "auto" },
      }),
    ).toMatchObject({
      hook_event_name: "PreCompact",
      session_id: "sess-1",
      transcript_path: "/tmp/t.jsonl",
    });

    expect(
      payloadFor({
        kind: "preToolUse",
        ctx: { toolName: "Write", toolInput: "{}", sessionId: "sess-2", cwd: "/work/project" },
      }),
    ).toMatchObject({ session_id: "sess-2", cwd: "/work/project" });
  });

  test("omits ambient fields the call site does not know", () => {
    const payload = payloadFor({
      kind: "preToolUse",
      ctx: { toolName: "Write", toolInput: "{}" },
    });

    expect(payload).not.toHaveProperty("session_id");
    expect(payload).not.toHaveProperty("cwd");
    expect(payload).not.toHaveProperty("transcript_path");
  });

  test("stop_hook_active is a boolean, not the env string", () => {
    expect(
      payloadFor({ kind: "stop", ctx: { sessionId: "s", stopHookActive: true } }),
    ).toMatchObject({ stop_hook_active: true });
    expect(payloadFor({ kind: "stop", ctx: { sessionId: "s" } })).toMatchObject({
      stop_hook_active: false,
    });
  });

  test("emits the reference field names for the added event roster", () => {
    const cases: Array<{ event: EventCtx; expected: Record<string, unknown> }> = [
      {
        event: {
          kind: "postToolUseFailure",
          ctx: {
            toolName: "Bash",
            toolInput: { command: "false" },
            toolUseId: "tool-1",
            error: "failed",
            isInterrupt: false,
          },
        },
        expected: {
          hook_event_name: "PostToolUseFailure",
          tool_input: { command: "false" },
          tool_use_id: "tool-1",
          error: "failed",
          is_interrupt: false,
        },
      },
      {
        event: {
          kind: "postToolBatch",
          ctx: {
            sessionId: "session-1",
            cwd: "/workspace",
            toolCalls: [{ tool_name: "Read", tool_input: {}, tool_use_id: "tool-2" }],
          },
        },
        expected: { hook_event_name: "PostToolBatch", tool_calls: expect.any(Array) },
      },
      {
        event: {
          kind: "userPromptExpansion",
          ctx: {
            expansionType: "slash_command",
            commandName: "review",
            commandArgs: "src",
            commandSource: "project",
            prompt: "Review src",
            sessionId: "session-1",
            cwd: "/workspace",
          },
        },
        expected: {
          hook_event_name: "UserPromptExpansion",
          expansion_type: "slash_command",
          command_name: "review",
          command_args: "src",
          command_source: "project",
          prompt: "Review src",
        },
      },
      {
        event: {
          kind: "stopFailure",
          ctx: {
            sessionId: "session-1",
            cwd: "/workspace",
            error: "server_error",
            errorDetails: "unavailable",
            lastAssistantMessage: "partial",
          },
        },
        expected: {
          hook_event_name: "StopFailure",
          error: "server_error",
          error_details: "unavailable",
          last_assistant_message: "partial",
        },
      },
      {
        event: {
          kind: "permissionRequest",
          ctx: {
            toolName: "Write",
            toolInput: { file_path: "/workspace/a.ts" },
            permissionSuggestions: [{ type: "addRules" }],
            sessionId: "session-1",
            cwd: "/workspace",
          },
        },
        expected: {
          hook_event_name: "PermissionRequest",
          tool_name: "Write",
          tool_input: { file_path: "/workspace/a.ts" },
          permission_suggestions: [{ type: "addRules" }],
        },
      },
      {
        event: {
          kind: "teammateIdle",
          ctx: {
            teammateName: "worker",
            teamName: "session",
            sessionId: "session-1",
            cwd: "/workspace",
          },
        },
        expected: {
          hook_event_name: "TeammateIdle",
          teammate_name: "worker",
          team_name: "session",
        },
      },
      {
        event: {
          kind: "elicitation",
          ctx: {
            mcpServerName: "example",
            message: "Choose",
            mode: "form",
            requestedSchema: { type: "object" },
            sessionId: "session-1",
            cwd: "/workspace",
          },
        },
        expected: {
          hook_event_name: "Elicitation",
          mcp_server_name: "example",
          mode: "form",
          requested_schema: { type: "object" },
        },
      },
      {
        event: {
          kind: "elicitationResult",
          ctx: {
            mcpServerName: "example",
            action: "accept",
            content: { choice: "a" },
            sessionId: "session-1",
            cwd: "/workspace",
          },
        },
        expected: {
          hook_event_name: "ElicitationResult",
          action: "accept",
          content: { choice: "a" },
        },
      },
      {
        event: {
          kind: "configChange",
          ctx: {
            source: "project_settings",
            filePath: "/workspace/settings.json",
            sessionId: "session-1",
            cwd: "/workspace",
          },
        },
        expected: {
          hook_event_name: "ConfigChange",
          source: "project_settings",
          file_path: "/workspace/settings.json",
        },
      },
      {
        event: {
          kind: "instructionsLoaded",
          ctx: {
            filePath: "/workspace/INSTRUCTIONS.md",
            memoryType: "Project",
            loadReason: "session_start",
            globs: ["src/**"],
            sessionId: "session-1",
            cwd: "/workspace",
          },
        },
        expected: {
          hook_event_name: "InstructionsLoaded",
          file_path: "/workspace/INSTRUCTIONS.md",
          memory_type: "Project",
          load_reason: "session_start",
          globs: ["src/**"],
        },
      },
      {
        event: {
          kind: "cwdChanged",
          ctx: {
            oldCwd: "/workspace/a",
            newCwd: "/workspace/b",
            sessionId: "session-1",
            cwd: "/workspace/b",
          },
        },
        expected: {
          hook_event_name: "CwdChanged",
          old_cwd: "/workspace/a",
          new_cwd: "/workspace/b",
        },
      },
      {
        event: {
          kind: "directoryAdded",
          ctx: {
            directory: "/workspace/shared",
            source: "cli_arg",
            sessionId: "session-1",
            cwd: "/workspace",
          },
        },
        expected: {
          hook_event_name: "DirectoryAdded",
          directory: "/workspace/shared",
          source: "cli_arg",
        },
      },
      {
        event: {
          kind: "messageDisplay",
          ctx: {
            turnId: "turn-1",
            messageId: "message-1",
            index: 2,
            final: true,
            delta: "done",
            sessionId: "session-1",
            cwd: "/workspace",
          },
        },
        expected: {
          hook_event_name: "MessageDisplay",
          turn_id: "turn-1",
          message_id: "message-1",
          index: 2,
          final: true,
          delta: "done",
        },
      },
    ];

    for (const { event, expected } of cases) expect(payloadFor(event)).toMatchObject(expected);
  });

  test("a hook process reads the payload on stdin and stdin is closed after it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hook-stdin-"));
    const out = join(dir, "payload.json");
    try {
      const outcome = await fireEntry(
        { matcher: "*", command: `cat > ${JSON.stringify(out)}` },
        {
          kind: "sessionStart",
          ctx: { sessionId: "sess-9", cwd: "/work/project", source: "startup" },
        },
      );

      expect(outcome.kind).toBe("ok");
      expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
        hook_event_name: "SessionStart",
        session_id: "sess-9",
        cwd: "/work/project",
        source: "startup",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a hook that never reads stdin neither blocks nor fails the runner", async () => {
    const outcome = await fireEntry(
      { matcher: "*", command: "exit 0" },
      { kind: "Setup", ctx: { hook_event_name: "Setup", trigger: "init" } },
    );

    expect(outcome.kind).toBe("ok");
  });

  test("a tool hook receives the session id and cwd the request context carries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hook-stdin-tool-"));
    const out = join(dir, "payload.json");
    try {
      const handlers = handlersFromHookMap({
        preToolUse: [{ matcher: "Bash", command: `cat > ${JSON.stringify(out)}` }],
      });
      const call: ToolCall = { id: "bash-1", name: "Bash", input: { command: "echo hi" } };

      await handlers[0]?.preToolUse?.(call, {
        sessionId: "sess-ctx",
        cwd: "/work/project",
      } as RequestContext);

      expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        session_id: "sess-ctx",
        cwd: "/work/project",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
