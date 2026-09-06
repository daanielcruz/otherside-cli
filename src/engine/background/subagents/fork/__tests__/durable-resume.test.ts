import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withSpawnedAgentScope } from "@/engine/agents/agent-context.ts";
import { clear as clearInboxes } from "@/engine/agents/inbox.ts";
import { register as registerAgent } from "@/engine/agents/registry.ts";
import {
  clearForkLifecyclesForTests,
  registerRunningFork,
  resolveForkProfileForResume,
} from "@/engine/background/subagents/lifecycle.ts";
import {
  clear as clearBackgroundTasks,
  completeTask,
  startTask,
} from "@/engine/background/tasks/background.ts";
import {
  type PermissionResolutionDeps,
  resolvePermission,
} from "@/engine/queue/runtime/permission-resolution.ts";
import { clear as clearPermissionQueue } from "@/kernel/channels/permission.ts";
import { saveRules } from "@/kernel/permissions/persist.ts";
import type { PermissionRule } from "@/kernel/permissions/types.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  type DurableForkSpecV1,
  serializeDurableForkSpec,
  writeDurableForkSpec,
} from "../durable-spec.ts";

afterEach(() => {
  clearInboxes();
  clearBackgroundTasks();
  clearForkLifecyclesForTests();
});

describe("durable fork resume", () => {
  test("consults the sidecar when the lifecycle registry has no fork", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "otherside-durable-resume-"));
    const providerId = "durable-resume-test" as RequestContext["provider"];
    const forkId = "durable-resume-fork";
    const sessionId = "durable-resume-session";
    const ctx: RequestContext = {
      provider: providerId,
      model: "durable-resume-model",
      effort: null,
      permissionMode: "default",
      cwd,
      originalCwd: cwd,
      sessionId,
    };
    const durable: DurableForkSpecV1 = {
      version: 1,
      forkId,
      kind: "fork",
      agentId: "fork",
      name: "durable-fork",
      prompt: "Original directive.",
      permissionMode: "plan",
      permissionModeIsDefinitionPinned: true,
      effort: "high",
      cwd,
      originalCwd: cwd,
      provider: providerId,
      model: ctx.model,
      sessionId,
      parentToolCallId: "durable-agent-call",
      allowSet: null,
    };
    await writeDurableForkSpec({ cwd, sessionId, forkId }, durable);

    const resolved = await resolveForkProfileForResume(forkId, ctx);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.profile.spec).toMatchObject({
      name: durable.name,
      prompt: durable.prompt,
      agentId: durable.agentId,
      permissionMode: durable.permissionMode,
      inheritParentTurn: true,
    });
    expect(resolved.profile.ctx).toMatchObject({
      provider: durable.provider,
      model: durable.model,
      effort: durable.effort,
      permissionMode: durable.permissionMode,
      cwd: durable.cwd,
      sessionId: durable.sessionId,
    });
    expect(resolved.profile.task?.forkId).toBe(forkId);
    expect(resolved.profile.spec.allowSet).toBeNull();

    const release = registerRunningFork(
      forkId,
      durable.name ?? durable.agentId,
      {
        ...resolved.profile.spec,
        prompt: "Resume-time prompt.",
        permissionMode: "yolo",
        preserveDurableSpec: true,
        initialMessages: [
          { role: "user", content: [{ type: "text", text: "Original directive." }] },
          {
            role: "user",
            content: [{ type: "text", text: "Persisted steer." }],
            id: "persisted-steer",
          },
        ],
      },
      { ...resolved.profile.ctx, permissionMode: "yolo" },
    );
    const duringResume = await resolveForkProfileForResume(forkId, ctx);
    expect(duringResume.ok).toBe(true);
    if (!duringResume.ok) throw new Error(duringResume.reason);
    expect(duringResume.profile.spec.prompt).toBe(durable.prompt);
    expect(duringResume.profile.spec.permissionMode).toBe(durable.permissionMode);
    expect(duringResume.profile.ctx.permissionMode).toBe(durable.permissionMode);
    expect(duringResume.profile.baseMessages).toBeUndefined();
    release();
  });

  test("refreshes an inherited named agent mode from the live broker on resume", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "otherside-durable-inherited-mode-"));
    const providerId = "durable-inherited-mode-test" as RequestContext["provider"];
    const sessionId = "durable-inherited-mode-session";
    const forkId = "durable-inherited-mode-fork";
    const agentId = "durable-inherited-mode-agent";
    registerAgent({
      id: agentId,
      name: "Durable inherited mode agent",
      description: "test agent",
      body: "",
      tools: null,
      disallowedTools: null,
      model: {},
      background: true,
      scope: "project",
    });
    const spawnCtx: RequestContext = {
      provider: providerId,
      model: "durable-inherited-mode-model",
      effort: null,
      permissionMode: "yolo",
      cwd,
      originalCwd: cwd,
      sessionId,
    };
    const durable = serializeDurableForkSpec(
      {
        ctx: spawnCtx,
        name: "durable-inherited-mode-worker",
        body: "",
        allowSet: null,
        prompt: "Original directive.",
        agentId,
      },
      forkId,
      spawnCtx,
    );
    await writeDurableForkSpec({ cwd, sessionId, forkId }, durable);

    expect(durable.permissionMode).toBe("yolo");
    expect(durable.permissionModeIsDefinitionPinned).toBe(false);

    for (const mode of ["default", "accept-edits", "plan", "yolo"] as const) {
      clearForkLifecyclesForTests();
      const requestCtx: RequestContext = {
        ...spawnCtx,
        // Deliberately stale: resume must consult the broker, not this snapshot.
        permissionMode: "yolo",
        broker: {
          read: () => ({ permissionMode: mode }) as never,
          dispatch: () => {},
        },
      };

      const resolved = await resolveForkProfileForResume(forkId, requestCtx);

      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error(resolved.reason);
      expect(resolved.profile.ctx.permissionMode).toBe(mode);
      expect(resolved.profile.spec.permissionMode).toBeUndefined();
      // A resumed named agent remains asynchronous, so this inherited default
      // reaches the existing background ask → auto-deny path instead of yolo.
      expect(resolved.profile.spec.shouldAvoidPermissionPrompts).toBe(true);
      expect(resolved.profile.spec.allowSet).toBeInstanceOf(Set);
      expect(resolved.profile.spec.allowSet?.has("TaskStop")).toBe(true);
      expect(resolved.profile.spec.allowSet?.has("TaskCreate")).toBe(false);
      expect(resolved.profile.spec.allowSet?.has("TaskGet")).toBe(false);
      expect(resolved.profile.spec.allowSet?.has("TaskList")).toBe(false);
      expect(resolved.profile.spec.allowSet?.has("TaskUpdate")).toBe(false);

      if (mode !== "yolo") continue;
      const previousConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
      process.env.OTHERSIDE_CONFIG_DIR = join(cwd, "config");
      const permissionDeps: PermissionResolutionDeps = {
        injections: { push: () => {}, drain: () => [], peek: () => [] },
        sessionAllowedToolPatterns: new Set<string>(),
        agentDeps: {
          broker: { read: () => ({ permissionMode: "yolo" }) },
          session: { id: sessionId, cwd },
          config: {},
        },
      } as unknown as PermissionResolutionDeps;
      const agentContext = {
        agentId: forkId,
        depth: 1,
        parentSessionId: sessionId,
        agentType: "subagent" as const,
        subagentName: resolved.profile.name,
        sessionAllowedToolPatterns: new Set<string>(),
        shouldAvoidPermissionPrompts: true,
      };
      const outsideWrite = () =>
        withSpawnedAgentScope(agentContext, () =>
          resolvePermission(permissionDeps, {
            id: "durable-inherited-mode-write",
            name: "Write",
            input: { file_path: join(cwd, "..", "outside.ts"), content: "outside" },
          }),
        );
      const writeRule = (behavior: "ask" | "deny"): PermissionRule => ({
        source: "localSettings",
        ruleBehavior: behavior,
        ruleValue: { toolName: "Write" },
      });
      try {
        // Live yolo still wins when no rule applies. Explicit deny and ask rules
        // remain ahead of it; the asynchronous child auto-denies the latter.
        expect(await outsideWrite()).toBe("allow");
        await saveRules([writeRule("deny")], cwd);
        expect(await outsideWrite()).toBe("deny");
        await saveRules([writeRule("ask")], cwd);
        expect(await outsideWrite()).toMatchObject({ kind: "deny" });
      } finally {
        clearPermissionQueue();
        if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
        else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("keeps a user stop across a restart without rebuilding the profile", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "otherside-durable-stopped-resume-"));
    const providerId = "durable-stopped-resume-test" as RequestContext["provider"];
    const sessionId = "durable-stopped-resume-session";
    const parentToolCallId = "durable-stopped-agent-call";
    const agentName = "durable-stopped-fork";
    const task = startTask({
      parentToolCallId,
      agentName,
      agentId: "fork",
      cwd,
      sessionId,
      isBackgrounded: true,
    });
    const forkId = task.id;
    const ctx: RequestContext = {
      provider: providerId,
      model: "durable-stopped-resume-model",
      effort: null,
      permissionMode: "default",
      cwd,
      originalCwd: cwd,
      sessionId,
    };
    const release = registerRunningFork(
      forkId,
      agentName,
      {
        ctx,
        name: agentName,
        body: "",
        allowSet: null,
        prompt: "Original directive.",
        inheritParentTurn: true,
      },
      ctx,
    );
    completeTask(task.id, {
      content: "Stopped by user",
      isError: false,
      killed: true,
      userInitiated: true,
    });
    release();

    clearForkLifecyclesForTests();
    clearBackgroundTasks();

    const resolved = await resolveForkProfileForResume(forkId, ctx);
    expect(resolved).toMatchObject({ ok: false, code: "stopped_by_user" });
    expect(resolved).not.toHaveProperty("profile");
  });
});
