import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  type DurableForkSpecV1,
  isDurableForkStopped,
  markDurableForkStopped,
  readDurableForkSpec,
  serializeDurableForkSpec,
  writeDurableForkSpec,
} from "../durable-spec.ts";
import type { ForkSpec } from "../types.ts";

describe("durable fork spec", () => {
  test("round-trips the resume fields through the adjacent sidecar", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "otherside-fork-spec-"));
    const ctx: RequestContext = {
      provider: "durable-spec-test" as RequestContext["provider"],
      model: "durable-model",
      effort: null,
      permissionMode: "default",
      cwd,
      originalCwd: cwd,
      sessionId: "durable-session",
      worktreeRoot: join(cwd, "worktree"),
    };
    const spec: ForkSpec = {
      ctx,
      name: "durable-worker",
      body: "runtime-only body",
      allowSet: new Set(["Write", "Read"]),
      deferredAllow: new Set(["WebFetch"]),
      prompt: "Original directive.",
      description: "Durable worker",
      agentId: "general-purpose",
      parentToolCallId: "agent-call",
      permissionMode: "plan",
      permissionModeIsDefinitionPinned: true,
      isolation: "worktree",
    };
    const durable = serializeDurableForkSpec(spec, "fork-durable", ctx);
    const ref = { cwd, sessionId: ctx.sessionId, forkId: durable.forkId };

    await writeDurableForkSpec(ref, durable);

    expect(await readDurableForkSpec(ref)).toEqual(durable);
    expect(durable.permissionMode).toBe("plan");
    expect(durable.permissionModeIsDefinitionPinned).toBe(true);
    expect(durable.effort).toBeNull();
    const {
      permissionMode: _override,
      permissionModeIsDefinitionPinned: _pinned,
      ...inheritedSpec
    } = spec;
    const inherited = serializeDurableForkSpec(inheritedSpec, "fork-inherited", ctx);
    expect(inherited.permissionMode).toBe("default");
    expect(inherited.permissionModeIsDefinitionPinned).toBe(false);
    expect(durable.allowSet).toEqual(["Read", "Write"]);
    expect(durable.deferredAllow).toEqual(["WebFetch"]);
  });

  test("persists a stop marker without altering the durable spec", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "otherside-fork-stop-"));
    const ref = {
      cwd,
      sessionId: "durable-stop-session",
      forkId: "durable-stop-fork",
    };
    const durable: DurableForkSpecV1 = {
      version: 1,
      forkId: ref.forkId,
      kind: "fork",
      agentId: "fork",
      name: "durable-stop-worker",
      prompt: "Original directive.",
      permissionMode: "default",
      effort: null,
      cwd,
      originalCwd: cwd,
      provider: "durable-stop-test",
      model: "durable-stop-model",
      sessionId: ref.sessionId,
      allowSet: null,
    };
    await writeDurableForkSpec(ref, durable);

    expect(isDurableForkStopped(ref)).toBe(false);
    markDurableForkStopped(ref);
    expect(isDurableForkStopped(ref)).toBe(true);
    expect(await readDurableForkSpec(ref)).toEqual(durable);

    const pathLikeRef = { ...ref, forkId: "../../outside" };
    expect(isDurableForkStopped(pathLikeRef)).toBe(false);
    expect(() => markDurableForkStopped(pathLikeRef)).toThrow(
      "invalid durable fork id: ../../outside",
    );
  });

  test("rejects a path-like fork id before resolving a sidecar path", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "otherside-fork-spec-id-"));
    expect(
      await readDurableForkSpec({
        cwd,
        sessionId: "durable-session",
        forkId: "../../outside",
      }),
    ).toBeNull();
  });
});
