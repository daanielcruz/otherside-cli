import { describe, expect, test } from "bun:test";
import { Bash } from "@/engine/tools/builtins/bash.ts";
import { dispatch } from "@/engine/tools/pipeline.ts";
import { preToolUseHookPermissionSignal } from "@/engine/tools/pretooluse-hook-permission-context.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type {
  BrokerHandle,
  RequestContext,
  ScopedToolHandler,
} from "@/kernel/std/types/request.ts";

const call: ToolCall = {
  id: "tool-1",
  name: "Bash",
  input: { command: "rm build/out.txt" },
};

function context(permissionModeIsFixed: boolean): RequestContext {
  const handler: ScopedToolHandler = {
    schema: {
      name: "Bash",
      description: "test",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
    run: async (): Promise<ToolResult> => ({ tool_use_id: call.id, content: "ran" }),
  };
  return {
    provider: "anthropic",
    model: "test",
    effort: null,
    permissionMode: "default",
    permissionModeIsFixed,
    sessionId: "session-1",
    cwd: "/tmp/project",
    broker: {
      read: () => ({
        provider: "anthropic",
        model: "test",
        effort: null,
        fastMode: false,
        permissionMode: "accept-edits",
      }),
      dispatch: () => {},
    } as BrokerHandle,
    scopedToolHandlers: new Map([["Bash", handler]]),
  };
}

describe("tool pipeline fixed permission mode", () => {
  test("delegates accept-edits decisions to the permission resolver", async () => {
    const ctx = context(false);
    let permissionCalls = 0;

    const result = await dispatch(call, ctx, {
      permission: async () => {
        permissionCalls += 1;
        return "deny";
      },
      hooks: [],
    });

    expect(result).toEqual({
      tool_use_id: call.id,
      content: "permission denied",
      is_error: true,
    });
    expect(permissionCalls).toBe(1);
  });

  test("does not inherit broker accept-edits", async () => {
    const ctx = context(true);
    let permissionCalls = 0;

    const result = await dispatch(call, ctx, {
      permission: async () => {
        permissionCalls += 1;
        return "deny";
      },
      hooks: [],
    });

    expect(result).toEqual({
      tool_use_id: call.id,
      content: "permission denied",
      is_error: true,
    });
    expect(permissionCalls).toBe(1);
  });
});

function bashContext(seen: ToolCall[]): RequestContext {
  const ctx = context(true);
  const handler: ScopedToolHandler = {
    ...Bash,
    run: async (coercedCall): Promise<ToolResult> => {
      seen.push(coercedCall);
      return { tool_use_id: coercedCall.id, content: "ran" };
    },
  };
  return { ...ctx, scopedToolHandlers: new Map([["Bash", handler]]) };
}

async function dispatchBash(input: unknown, seen: ToolCall[]): Promise<ToolResult> {
  return dispatch({ id: "bash-coercion", name: "Bash", input }, bashContext(seen), {
    permission: async () => "allow",
    hooks: [],
  });
}

describe("PreToolUse hooks run before permission is resolved", () => {
  test("never asks for permission before PreToolUse hooks run, and blocks execution when a hook blocks", async () => {
    const executed: ToolCall[] = [];
    let permissionCalls = 0;
    const original: ToolCall = {
      id: "hook-block",
      name: "Bash",
      input: { command: "touch /outside-file" },
    };

    const result = await dispatch(original, bashContext(executed), {
      permission: async () => {
        permissionCalls += 1;
        return "allow";
      },
      hooks: [
        {
          preToolUse: async () => "block",
        },
      ],
    });

    expect(result).toEqual({
      tool_use_id: original.id,
      content: "blocked by hook",
      is_error: true,
    });
    // The scenario this guards against: upstream runs PreToolUse hooks before
    // ever asking the user for permission. A hook that blocks the call must
    // pre-empt the permission prompt entirely, not merely override its result.
    expect(permissionCalls).toBe(0);
    expect(executed).toHaveLength(0);
  });

  test("surfaces a hook's structured block reason instead of a generic message (PERM-HOOK-DECISION-002)", async () => {
    const executed: ToolCall[] = [];
    let permissionCalls = 0;
    const original: ToolCall = {
      id: "hook-block-reason",
      name: "Bash",
      input: { command: "touch /outside-file" },
    };

    const result = await dispatch(original, bashContext(executed), {
      permission: async () => {
        permissionCalls += 1;
        return "allow";
      },
      hooks: [
        {
          preToolUse: async () => ({ kind: "block", reason: "policy" }),
        },
      ],
    });

    expect(result).toEqual({
      tool_use_id: original.id,
      content: "policy",
      is_error: true,
    });
    expect(permissionCalls).toBe(0);
    expect(executed).toHaveLength(0);
  });

  test("resolves permission exactly once, against the final hook-updated input", async () => {
    const executed: ToolCall[] = [];
    const checked: ToolCall[] = [];
    const original: ToolCall = {
      id: "hook-rewrite",
      name: "Bash",
      input: { command: "touch workspace-file" },
    };

    const result = await dispatch(original, bashContext(executed), {
      permission: async (candidate) => {
        checked.push(candidate);
        return "allow";
      },
      hooks: [
        {
          preToolUse: async (candidate) => ({
            ...candidate,
            input: { command: "touch /outside-file" },
          }),
        },
      ],
    });

    expect(result.content).toBe("ran");
    // Permission must be asked exactly once, and only for the final,
    // hook-rewritten input -- never for the original model-authored input.
    expect(checked.map((candidate) => candidate.input)).toEqual([
      { command: "touch /outside-file" },
    ]);
    expect(executed).toHaveLength(1);
    expect(executed[0]?.input).toEqual({ command: "touch /outside-file" });
  });

  test("lets an explicit deny rule govern the final hook-updated input", async () => {
    const executed: ToolCall[] = [];
    const checked: ToolCall[] = [];
    const original: ToolCall = {
      id: "hook-rewrite-deny",
      name: "Bash",
      input: { command: "touch workspace-file" },
    };

    const result = await dispatch(original, bashContext(executed), {
      permission: async (candidate) => {
        checked.push(candidate);
        return (candidate.input as { command: string }).command === "touch /outside-file"
          ? { kind: "deny", message: "denied by explicit rule" }
          : "allow";
      },
      hooks: [
        {
          preToolUse: async (candidate) => ({
            ...candidate,
            input: { command: "touch /outside-file" },
          }),
        },
      ],
    });

    expect(result).toEqual({
      tool_use_id: original.id,
      content: "denied by explicit rule",
      is_error: true,
    });
    // Only the final input is ever checked against permission/deny-ask rules.
    expect(checked.map((candidate) => candidate.input)).toEqual([
      { command: "touch /outside-file" },
    ]);
    expect(executed).toHaveLength(0);
  });
});

describe("PreToolUse hook permissionDecision allow/ask is threaded to permission resolution (PERM-HOOK-ALLOW-BYPASS-001)", () => {
  test("an explicit hook allow is visible to the permission resolver via the hook-permission context", async () => {
    const executed: ToolCall[] = [];
    const seenSignals: (string | undefined)[] = [];
    const original: ToolCall = {
      id: "hook-allow-signal",
      name: "Bash",
      input: { command: "touch workspace-file" },
    };

    const result = await dispatch(original, bashContext(executed), {
      permission: async () => {
        seenSignals.push(preToolUseHookPermissionSignal());
        return "allow";
      },
      hooks: [{ preToolUse: async (candidate) => ({ kind: "allow", call: candidate }) }],
    });

    expect(result.content).toBe("ran");
    expect(seenSignals).toEqual(["allow"]);
  });

  test("an explicit hook ask is visible to the permission resolver via the hook-permission context", async () => {
    const executed: ToolCall[] = [];
    const seenSignals: (string | undefined)[] = [];
    const original: ToolCall = {
      id: "hook-ask-signal",
      name: "Bash",
      input: { command: "touch workspace-file" },
    };

    const result = await dispatch(original, bashContext(executed), {
      permission: async () => {
        seenSignals.push(preToolUseHookPermissionSignal());
        return "allow";
      },
      hooks: [{ preToolUse: async (candidate) => ({ kind: "ask", call: candidate }) }],
    });

    expect(result.content).toBe("ran");
    expect(seenSignals).toEqual(["ask"]);
  });

  test("a decision-less passthrough hook carries no permission signal (unchanged default)", async () => {
    const executed: ToolCall[] = [];
    const seenSignals: (string | undefined)[] = [];
    const original: ToolCall = {
      id: "hook-passthrough-signal",
      name: "Bash",
      input: { command: "touch workspace-file" },
    };

    const result = await dispatch(original, bashContext(executed), {
      permission: async () => {
        seenSignals.push(preToolUseHookPermissionSignal());
        return "allow";
      },
      hooks: [{ preToolUse: async (candidate) => candidate }],
    });

    expect(result.content).toBe("ran");
    expect(seenSignals).toEqual([undefined]);
  });

  test("a later hook's ask is never downgraded by an earlier hook's plain allow, across the whole chain", async () => {
    const executed: ToolCall[] = [];
    const seenSignals: (string | undefined)[] = [];
    const original: ToolCall = {
      id: "hook-chain-ask-outranks-allow",
      name: "Bash",
      input: { command: "touch workspace-file" },
    };

    const result = await dispatch(original, bashContext(executed), {
      permission: async () => {
        seenSignals.push(preToolUseHookPermissionSignal());
        return "allow";
      },
      hooks: [
        { preToolUse: async (candidate) => ({ kind: "allow", call: candidate }) },
        { preToolUse: async (candidate) => ({ kind: "ask", call: candidate }) },
      ],
    });

    expect(result.content).toBe("ran");
    expect(seenSignals).toEqual(["ask"]);
  });
});

describe("PostToolUse hook failures are surfaced separately (PERM-HOOK-POST-003)", () => {
  test("a postToolUse handler that throws keeps the tool's original result and appends feedback instead of overwriting it", async () => {
    const executed: ToolCall[] = [];
    const original: ToolCall = {
      id: "post-throw",
      name: "Bash",
      input: { command: "echo hi" },
    };

    const result = await dispatch(original, bashContext(executed), {
      permission: async () => "allow",
      hooks: [
        {
          async postToolUse() {
            throw new Error("hook process crashed");
          },
        },
      ],
    });

    // Before this fix, a throwing postToolUse hook replaced the whole
    // ToolResult, discarding the fact the tool itself actually succeeded.
    expect(result.is_error).toBeUndefined();
    expect(result.content).toEqual([
      { type: "text", text: "ran" },
      {
        type: "text",
        text: "PostToolUse hook feedback:\npostToolUse hook threw: hook process crashed",
      },
    ]);
    expect(executed).toHaveLength(1);
  });

  test("explicit permission denial still pre-empts execution entirely, so no postToolUse hook ever runs", async () => {
    const executed: ToolCall[] = [];
    let postToolUseCalls = 0;
    const original: ToolCall = {
      id: "post-deny",
      name: "Bash",
      input: { command: "echo hi" },
    };

    const result = await dispatch(original, bashContext(executed), {
      permission: async () => ({ kind: "deny", message: "denied by explicit rule" }),
      hooks: [
        {
          async postToolUse(_call, toolResult) {
            postToolUseCalls += 1;
            return toolResult;
          },
        },
      ],
    });

    expect(result).toEqual({
      tool_use_id: original.id,
      content: "denied by explicit rule",
      is_error: true,
    });
    expect(executed).toHaveLength(0);
    expect(postToolUseCalls).toBe(0);
  });
});

describe("Bash semantic input coercion", () => {
  test("coerces numeric and exact lowercase boolean strings before validation", async () => {
    const seen: ToolCall[] = [];
    const result = await dispatchBash(
      {
        command: ":",
        timeout: "5000",
        run_in_background: "true",
        dangerouslyDisableSandbox: "false",
      },
      seen,
    );

    expect(result.content).toBe("ran");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.input).toEqual({
      command: ":",
      timeout: 5000,
      run_in_background: true,
      dangerouslyDisableSandbox: false,
    });
  });

  test("leaves native values unchanged", async () => {
    const seen: ToolCall[] = [];
    const result = await dispatchBash(
      {
        command: ":",
        timeout: 2500,
        run_in_background: false,
        dangerouslyDisableSandbox: true,
      },
      seen,
    );

    expect(result.content).toBe("ran");
    expect(seen[0]?.input).toEqual({
      command: ":",
      timeout: 2500,
      run_in_background: false,
      dangerouslyDisableSandbox: true,
    });
  });

  test("leaves invalid strings for schema validation to reject", async () => {
    const seen: ToolCall[] = [];
    const result = await dispatchBash(
      {
        command: ":",
        timeout: "soon",
        run_in_background: "yes",
        dangerouslyDisableSandbox: "TRUE",
      },
      seen,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("The parameter `timeout` type is expected as `number`");
    expect(result.content).toContain(
      "The parameter `run_in_background` type is expected as `boolean`",
    );
    expect(result.content).toContain(
      "The parameter `dangerouslyDisableSandbox` type is expected as `boolean`",
    );
    expect(seen).toHaveLength(0);
  });
});
