import { describe, expect, test } from "bun:test";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import { fireEntry } from "../exec.ts";
import {
  fireUserPromptSubmitHooks,
  handlersFromHookMap,
  preToolUseDecisionFromOutcomes,
} from "../handler.ts";
import { hookOutcomeText, hookResponseFromStdout } from "../response.ts";

function configWith(hooks: UserConfig["hooks"]): UserConfig {
  return { hooks } as UserConfig;
}

describe("hook response field parsing", () => {
  test("reads continue, suppressOutput and systemMessage; ignores wrong types", () => {
    expect(
      hookResponseFromStdout(
        JSON.stringify({ continue: false, suppressOutput: true, systemMessage: "note" }),
      ),
    ).toEqual({ continue: false, suppressOutput: true, systemMessage: "note" });

    expect(
      hookResponseFromStdout(
        JSON.stringify({ continue: "no", suppressOutput: 1, systemMessage: "   " }),
      ),
    ).toEqual({});

    expect(hookResponseFromStdout("not json at all")).toEqual({});
  });
});

describe("continue: false", () => {
  test("an exit-0 hook that returns continue:false lands on the blocked outcome channel", async () => {
    const outcome = await fireEntry(
      {
        matcher: "*",
        command: `printf '%s' '{"continue":false,"systemMessage":"policy says no"}'`,
      },
      { kind: "stop", ctx: { sessionId: "s" } },
    );

    expect(outcome).toEqual({ kind: "prompt_blocked", reason: "policy says no" });
  });

  test("PreToolUse treats it exactly like an explicit deny", () => {
    const decision = preToolUseDecisionFromOutcomes([
      { kind: "prompt_blocked", reason: "policy says no" },
    ]);

    expect(decision).toEqual({ action: "block", reason: "policy says no" });
  });

  test("a UserPromptSubmit hook that stops the flow reports a non-ok outcome to the gate", async () => {
    const result = await fireUserPromptSubmitHooks(
      configWith({
        userPromptSubmit: [
          { matcher: "*", command: `printf '%s' '{"continue":false,"systemMessage":"blocked"}'` },
        ],
      }),
      "hello",
    );

    expect(result.outcomes).toEqual([{ kind: "prompt_blocked", reason: "blocked" }]);
    expect(result.outcomes.some((outcome) => outcome.kind !== "ok")).toBe(true);
  });

  test("continue:true leaves the flow alone", async () => {
    const outcome = await fireEntry(
      { matcher: "*", command: `printf '%s' '{"continue":true}'` },
      { kind: "stop", ctx: { sessionId: "s" } },
    );

    expect(outcome.kind).toBe("ok");
  });
});

describe("suppressOutput", () => {
  test("keeps the hook's stdout off text surfaces but never hides stderr", () => {
    expect(hookOutcomeText({ stdout: JSON.stringify({ suppressOutput: true }), stderr: "" })).toBe(
      "",
    );
    expect(hookOutcomeText({ stdout: "chatty output", stderr: "" })).toBe("chatty output");
    expect(
      hookOutcomeText({ stdout: JSON.stringify({ suppressOutput: true }), stderr: "real error" }),
    ).toBe("real error");
  });

  test("a failing PostToolUse hook with suppressOutput falls back to the exit code, not its stdout", async () => {
    const handlers = handlersFromHookMap({
      postToolUse: [
        {
          matcher: "Bash",
          command: `printf '%s' '{"suppressOutput":true,"secret":"leak"}'; exit 3`,
        },
      ],
    });
    const call: ToolCall = { id: "bash-1", name: "Bash", input: { command: "echo hi" } };
    const toolResult: ToolResult = { tool_use_id: call.id, content: "hi" };

    const result = await handlers[0]?.postToolUse?.(call, toolResult, undefined as never);

    expect(result?.content).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "PostToolUse hook feedback:\nhook exited with code 3" },
    ]);
  });
});

describe("systemMessage", () => {
  test("rides the UserPromptSubmit context channel that already reaches the model", async () => {
    const result = await fireUserPromptSubmitHooks(
      configWith({
        userPromptSubmit: [
          {
            matcher: "*",
            command: `printf '%s' '{"additionalContext":"ctx","systemMessage":"heads up"}'`,
          },
        ],
      }),
      "hello",
    );

    expect(result.additionalContext).toEqual(["ctx", "heads up"]);
  });

  test("rides the PostToolUse feedback block that already reaches the model", async () => {
    const handlers = handlersFromHookMap({
      postToolUse: [
        { matcher: "Bash", command: `printf '%s' '{"systemMessage":"formatted the file"}'` },
      ],
    });
    const call: ToolCall = { id: "bash-2", name: "Bash", input: { command: "echo hi" } };
    const toolResult: ToolResult = { tool_use_id: call.id, content: "hi" };

    const result = await handlers[0]?.postToolUse?.(call, toolResult, undefined as never);

    expect(result?.content).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "PostToolUse hook feedback:\nformatted the file" },
    ]);
  });

  test("becomes the block reason when the hook also stops the flow", async () => {
    const handlers = handlersFromHookMap({
      preToolUse: [
        {
          matcher: "Write",
          command: `printf '%s' '{"continue":false,"systemMessage":"writes are frozen"}'`,
        },
      ],
    });
    const call: ToolCall = { id: "write-1", name: "Write", input: { file_path: "/tmp/x" } };

    const result = await handlers[0]?.preToolUse?.(call, undefined as never);

    expect(result).toEqual({ kind: "block", reason: "writes are frozen" });
  });
});
