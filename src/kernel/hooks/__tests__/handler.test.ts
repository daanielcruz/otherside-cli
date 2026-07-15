import { describe, expect, test } from "bun:test";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { HookOutcome } from "../exec.ts";
import {
  appendPostToolUseFeedback,
  handlersFromHookMap,
  matches,
  permissionDeniedRetryFromOutcomes,
  preToolUseDecisionFromOutcomes,
} from "../handler.ts";

function okOutcome(stdout: string): HookOutcome {
  return { kind: "ok", stdout, stderr: "", exit: 0 };
}

describe("matches", () => {
  test("behaves as regex or pipe-separated exact match", () => {
    expect(matches("Bash|Edit", "Bash")).toBe(true);
    expect(matches("Bash|Edit", "Write")).toBe(false);
    expect(matches("^Wri", "Write")).toBe(true);
    expect(matches("*", "anything")).toBe(true);
    expect(matches("Bash", "bash")).toBe(false);
    expect(matches("[", "Bash")).toBe(false);
  });
});

describe("PermissionDenied hook output", () => {
  test("parses hookSpecificOutput retry true from successful hook stdout", () => {
    const outcomes: HookOutcome[] = [
      {
        kind: "ok",
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: "PermissionDenied", retry: true },
        }),
        stderr: "",
        exit: 0,
      },
    ];

    expect(permissionDeniedRetryFromOutcomes(outcomes)).toBe(true);
  });
});

describe("preToolUseDecisionFromOutcomes (PERM-HOOK-DECISION-002)", () => {
  test("blocks on a successful top-level {decision:block} JSON output, not just a nonzero exit", () => {
    // The exact regression scenario: the hook process exits 0 (kind: "ok") but
    // its stdout carries a block decision. Before this fix, only outcome.kind
    // was consulted, so this was silently treated as success.
    const outcomes = [okOutcome(JSON.stringify({ decision: "block", reason: "policy" }))];

    const decision = preToolUseDecisionFromOutcomes(outcomes);

    expect(decision).toEqual({ action: "block", reason: "policy" });
  });

  test("blocks on hookSpecificOutput.permissionDecision: deny, preferring its reason over a top-level one", () => {
    const outcomes = [
      okOutcome(
        JSON.stringify({
          reason: "generic",
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "escapes the sandbox",
          },
        }),
      ),
    ];

    const decision = preToolUseDecisionFromOutcomes(outcomes);

    expect(decision).toEqual({ action: "block", reason: "escapes the sandbox" });
  });

  test("allows and rewrites the call input when permissionDecision is allow with updatedInput", () => {
    const outcomes = [
      okOutcome(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: { file_path: "/workspace/safe.txt" },
          },
        }),
      ),
    ];

    const decision = preToolUseDecisionFromOutcomes(outcomes);

    expect(decision).toEqual({
      action: "allow",
      updatedInput: { file_path: "/workspace/safe.txt" },
      hookPermission: "allow",
    });
  });

  test("plain successful stdout with no JSON decision still allows (unchanged default)", () => {
    const outcomes = [okOutcome("ok, nothing to see here")];

    expect(preToolUseDecisionFromOutcomes(outcomes)).toEqual({
      action: "allow",
      updatedInput: undefined,
    });
  });

  test("a nonzero exit still blocks (fail-closed default for hook execution errors is preserved)", () => {
    const outcomes: HookOutcome[] = [
      { kind: "non_zero_exit", code: 1, stdout: "", stderr: "denied\n" },
    ];

    const decision = preToolUseDecisionFromOutcomes(outcomes);

    expect(decision).toEqual({ action: "block", reason: "denied" });
  });

  test("explicit deny precedence: one hook's deny wins over another hook's allow, regardless of order", () => {
    const allowThenDeny = [
      okOutcome(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
        }),
      ),
      okOutcome(JSON.stringify({ decision: "block", reason: "second hook vetoes" })),
    ];
    const denyThenAllow = [
      okOutcome(JSON.stringify({ decision: "block", reason: "first hook vetoes" })),
      okOutcome(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
        }),
      ),
    ];

    expect(preToolUseDecisionFromOutcomes(allowThenDeny)).toEqual({
      action: "block",
      reason: "second hook vetoes",
    });
    expect(preToolUseDecisionFromOutcomes(denyThenAllow)).toEqual({
      action: "block",
      reason: "first hook vetoes",
    });
  });

  test("explicit ask precedence: ask outranks a later plain allow (never silently downgraded)", () => {
    const outcomes = [
      okOutcome(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" },
        }),
      ),
      okOutcome(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
        }),
      ),
    ];

    // "ask" must never be silently overridden back down to a plain "allow" by
    // a later hook -- deny still remains the only outcome that actually
    // blocks the call outright, but the winning hookPermission stays "ask" so
    // a caller threading it into permission resolution still forces the
    // interactive/headless prompt (PERM-HOOK-ALLOW-BYPASS-001).
    expect(preToolUseDecisionFromOutcomes(outcomes)).toEqual({
      action: "allow",
      updatedInput: undefined,
      hookPermission: "ask",
    });
  });

  test("a deny decision never carries an updatedInput through, even if an earlier hook provided one", () => {
    const outcomes = [
      okOutcome(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: { command: "touch /outside" },
          },
        }),
      ),
      okOutcome(JSON.stringify({ decision: "block", reason: "vetoed after rewrite" })),
    ];

    expect(preToolUseDecisionFromOutcomes(outcomes)).toEqual({
      action: "block",
      reason: "vetoed after rewrite",
    });
  });
});

describe("handlersFromHookMap preToolUse (end-to-end, PERM-HOOK-DECISION-002)", () => {
  test("a PreToolUse command that prints {decision:block} and exits 0 blocks an otherwise-permitted Write", async () => {
    const handlers = handlersFromHookMap({
      preToolUse: [
        {
          matcher: "Write",
          command: `printf '%s' '{"decision":"block","reason":"policy"}'`,
        },
      ],
    });

    const call: ToolCall = {
      id: "write-1",
      name: "Write",
      input: { file_path: "/workspace/file.txt", content: "hello" },
    };

    // Concrete regression scenario from PERM-HOOK-DECISION-002: the hook
    // process exits 0 (a "successful" hook run) but its stdout carries a
    // block decision. Before this fix, the probe's original call was
    // returned unmodified, letting the otherwise-permitted Write proceed.
    const result = await handlers[0]?.preToolUse?.(call, undefined as never);

    expect(result).toEqual({ kind: "block", reason: "policy" });
  });

  // Regression guard: PreToolUse ask/deny precedence must survive the
  // PostToolUse feedback changes below untouched -- ask still outranks a
  // plain allow, and a later allow never silently downgrades an earlier ask.
  test("ask still outranks allow across multiple PreToolUse hooks", () => {
    const outcomes = [
      okOutcome(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" },
        }),
      ),
      okOutcome(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
        }),
      ),
    ];

    expect(preToolUseDecisionFromOutcomes(outcomes)).toEqual({
      action: "allow",
      updatedInput: undefined,
      hookPermission: "ask",
    });
  });

  // PERM-HOOK-ALLOW-BYPASS-001: an explicit hookSpecificOutput.permissionDecision
  // must reach the pipeline as a tagged `{kind:"allow"|"ask", call}` outcome, not
  // just a bare (indistinguishable-from-passthrough) ToolCall, so it can be
  // threaded into permission resolution to bypass or force the prompt.
  test("tags an explicit allow permissionDecision distinctly from a decision-less passthrough", async () => {
    const handlers = handlersFromHookMap({
      preToolUse: [
        {
          matcher: "Bash",
          command: `printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'`,
        },
      ],
    });
    const call: ToolCall = { id: "bash-allow", name: "Bash", input: { command: "echo hi" } };

    const result = await handlers[0]?.preToolUse?.(call, undefined as never);

    expect(result).toEqual({ kind: "allow", call });
  });

  test("tags an explicit ask permissionDecision so the pipeline can force the prompt", async () => {
    const handlers = handlersFromHookMap({
      preToolUse: [
        {
          matcher: "Bash",
          command: `printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}'`,
        },
      ],
    });
    const call: ToolCall = { id: "bash-ask", name: "Bash", input: { command: "echo hi" } };

    const result = await handlers[0]?.preToolUse?.(call, undefined as never);

    expect(result).toEqual({ kind: "ask", call });
  });

  test("a decision-less passthrough hook still returns the bare (possibly rewritten) call", async () => {
    const handlers = handlersFromHookMap({
      preToolUse: [{ matcher: "Bash", command: `printf '%s' 'no json here'` }],
    });
    const call: ToolCall = { id: "bash-passthrough", name: "Bash", input: { command: "echo hi" } };

    const result = await handlers[0]?.preToolUse?.(call, undefined as never);

    expect(result).toEqual(call);
  });
});

describe("handlersFromHookMap postToolUse (PERM-HOOK-POST-003)", () => {
  test("a PostToolUse command that exits nonzero with stderr preserves the tool result and surfaces hook feedback separately", async () => {
    const handlers = handlersFromHookMap({
      postToolUse: [
        {
          matcher: "Bash",
          command: `printf 'boom' 1>&2; exit 7`,
        },
      ],
    });

    const call: ToolCall = {
      id: "bash-1",
      name: "Bash",
      input: { command: "echo hi" },
    };
    const toolResult: ToolResult = { tool_use_id: call.id, content: "hi" };

    // Concrete regression scenario: the tool already succeeded (toolResult is
    // untouched, is_error is absent) and its configured PostToolUse command
    // exits 7 with stderr. Before this fix, the nonzero HookOutcome was
    // discarded entirely -- the successful result passed through with no
    // trace the hook ever ran.
    const result = await handlers[0]?.postToolUse?.(call, toolResult, undefined as never);

    expect(result?.is_error).toBeUndefined();
    expect(result?.content).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "PostToolUse hook feedback:\nboom" },
    ]);
  });

  test("a successful PostToolUse hook leaves the tool result untouched", async () => {
    const handlers = handlersFromHookMap({
      postToolUse: [{ matcher: "Bash", command: `exit 0` }],
    });

    const call: ToolCall = { id: "bash-2", name: "Bash", input: { command: "echo hi" } };
    const toolResult: ToolResult = { tool_use_id: call.id, content: "hi" };

    const result = await handlers[0]?.postToolUse?.(call, toolResult, undefined as never);

    expect(result).toEqual(toolResult);
  });
});

describe("appendPostToolUseFeedback", () => {
  test("keeps the original ToolResult (including is_error) authoritative and appends feedback as a separate block", () => {
    const result: ToolResult = {
      tool_use_id: "call-1",
      content: "already an error",
      is_error: true,
    };

    const updated = appendPostToolUseFeedback(result, ["hook exited with code 7"]);

    expect(updated).toEqual({
      tool_use_id: "call-1",
      is_error: true,
      content: [
        { type: "text", text: "already an error" },
        { type: "text", text: "PostToolUse hook feedback:\nhook exited with code 7" },
      ],
    });
  });

  test("returns the result unchanged when there is no feedback", () => {
    const result: ToolResult = { tool_use_id: "call-1", content: "ran" };

    expect(appendPostToolUseFeedback(result, [])).toBe(result);
  });
});
