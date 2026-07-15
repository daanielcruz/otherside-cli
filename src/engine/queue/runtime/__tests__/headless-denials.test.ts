import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAllBuiltins } from "@/engine/tools/register-builtins.ts";
import {
  answer as answerPermission,
  clear as clearPermissionQueue,
  peek as peekPermission,
} from "@/kernel/channels/permission.ts";
import { saveRules } from "@/kernel/permissions/persist.ts";
import { setRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import type { ToolCall } from "@/kernel/std/types/message.ts";
import { recordHeadlessDenial, takeHeadlessDenials } from "../headless-denials.ts";
import { type PermissionResolutionDeps, resolvePermission } from "../permission-resolution.ts";

describe("headless denials collector", () => {
  it("accumulates per session and drains once", () => {
    recordHeadlessDenial("s1", { tool_name: "Bash", tool_use_id: "a", tool_input: {} });
    recordHeadlessDenial("s1", { tool_name: "Edit", tool_use_id: "b", tool_input: { x: 1 } });
    recordHeadlessDenial("s2", { tool_name: "Write", tool_use_id: "c", tool_input: {} });

    const s1 = takeHeadlessDenials("s1");
    expect(s1.map((d) => d.tool_name)).toEqual(["Bash", "Edit"]);
    // draining is one-shot
    expect(takeHeadlessDenials("s1")).toEqual([]);
    expect(takeHeadlessDenials("s2")).toHaveLength(1);
  });
});

describe("resolvePermission headless auto-deny", () => {
  beforeAll(() => {
    registerAllBuiltins();
  });
  afterEach(() => {
    setRuntimeKind(null);
    clearPermissionQueue();
    takeHeadlessDenials("sess-headless");
  });

  function makeDeps(
    mode: "default" | "yolo" = "default",
    cwd = "/tmp/otherside-headless-test",
  ): PermissionResolutionDeps {
    const session = { id: "sess-headless", cwd };
    const broker = { read: () => ({ permissionMode: mode }) };
    return {
      agentDeps: {
        broker,
        session,
        config: {},
      },
      injections: { push: () => {}, drain: () => [] },
      sessionAllowedToolPatterns: new Set<string>(),
    } as unknown as PermissionResolutionDeps;
  }

  it("denies a prompt-requiring tool and records the denial in print mode", async () => {
    setRuntimeKind("print");
    const call: ToolCall = {
      name: "Bash",
      id: "call-1",
      input: { command: "rm -rf /tmp/otherside-headless-test/x" },
    };
    const decision = await resolvePermission(makeDeps(), call);
    expect(typeof decision === "object" && decision.kind === "deny").toBe(true);

    const denials = takeHeadlessDenials("sess-headless");
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ tool_name: "Bash", tool_use_id: "call-1" });
    expect(denials[0]?.tool_input).toMatchObject({
      command: "rm -rf /tmp/otherside-headless-test/x",
    });
  });

  it("allows EnterPlanMode silently in print mode", async () => {
    setRuntimeKind("print");
    const call: ToolCall = { name: "EnterPlanMode", id: "call-enter-plan", input: {} };
    const decision = await resolvePermission(makeDeps(), call);

    expect(decision).toBe("allow");
    expect(takeHeadlessDenials("sess-headless")).toEqual([]);
  });

  it("denies AskUserQuestion before its dialog can hang in print mode, even in yolo", async () => {
    setRuntimeKind("print");
    for (const mode of ["default", "yolo"] as const) {
      const decision = await resolvePermission(makeDeps(mode), {
        id: `ask-user-question-${mode}`,
        name: "AskUserQuestion",
        input: { questions: [{ question: "Continue?", options: [] }] },
      });

      expect(typeof decision === "object" && decision.kind === "deny").toBe(true);
      expect(peekPermission()).toBeNull();
    }

    expect(takeHeadlessDenials("sess-headless")).toEqual([
      expect.objectContaining({
        tool_name: "AskUserQuestion",
        tool_use_id: "ask-user-question-default",
      }),
      expect.objectContaining({
        tool_name: "AskUserQuestion",
        tool_use_id: "ask-user-question-yolo",
      }),
    ]);
  });

  it("keeps explicit AskUserQuestion deny and ask rules ahead of yolo", async () => {
    const root = mkdtempSync(join(tmpdir(), "ask-user-question-permissions-"));
    const cwd = join(root, "project");
    const previousConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    mkdirSync(cwd, { recursive: true });
    process.env.OTHERSIDE_CONFIG_DIR = join(root, "config");
    setRuntimeKind("interactive");
    try {
      for (const mode of ["default", "yolo"] as const) {
        expect(
          await resolvePermission(makeDeps(mode, cwd), {
            id: `ask-user-question-interactive-${mode}`,
            name: "AskUserQuestion",
            input: { questions: [{ question: "Continue?", options: [] }] },
          }),
        ).toBe("allow");
        expect(peekPermission()).toBeNull();
      }

      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "deny",
            ruleValue: { toolName: "AskUserQuestion" },
          },
        ],
        cwd,
      );
      expect(
        await resolvePermission(makeDeps("yolo", cwd), {
          id: "ask-user-question-deny",
          name: "AskUserQuestion",
          input: { questions: [{ question: "Continue?", options: [] }] },
        }),
      ).toBe("deny");
      expect(peekPermission()).toBeNull();

      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "ask",
            ruleValue: { toolName: "AskUserQuestion" },
          },
        ],
        cwd,
      );
      const decision = resolvePermission(makeDeps("yolo", cwd), {
        id: "ask-user-question-ask",
        name: "AskUserQuestion",
        input: { questions: [{ question: "Continue?", options: [] }] },
      });
      const pending = await waitForPermission();
      expect(pending.toolName).toBe("AskUserQuestion");
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await decision).toBe("deny");
    } finally {
      if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
      else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function waitForPermission(): Promise<NonNullable<ReturnType<typeof peekPermission>>> {
  for (let i = 0; i < 100; i += 1) {
    const pending = peekPermission();
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("permission ask never surfaced");
}
