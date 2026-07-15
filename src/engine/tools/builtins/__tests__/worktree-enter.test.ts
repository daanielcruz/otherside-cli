import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ToolCall } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const enterSessionWorktreeMock = mock(
  (_ctx: RequestContext, opts: { name?: string; path?: string }) =>
    Promise.resolve({
      worktreePath: `/tmp/worktrees/${opts.path ?? opts.name ?? "auto"}`,
      worktreeBranch: opts.path ? undefined : `worktree-${opts.name ?? "auto"}`,
      message: opts.path
        ? `Entered existing worktree at ${opts.path}`
        : `Created worktree ${opts.name} at /tmp/worktrees/${opts.name}`,
    }),
);

mock.module("@/engine/session/worktree.ts", () => ({
  enterSessionWorktree: enterSessionWorktreeMock,
  exitSessionWorktree: mock(() => Promise.resolve({})),
  getActiveWorktree: mock(() => null),
}));

const { EnterWorktree, generateWorktreeSlug, validateWorktreeName } = await import(
  "../worktree-enter.ts"
);

const ctx = {
  provider: "anthropic",
  model: "claude-sonnet-4",
  effort: null,
  permissionMode: "default",
  sessionId: "sess-enter-wt",
  cwd: "/repo",
} as unknown as RequestContext;

function call(input: Record<string, unknown>, id = "ew-1"): ToolCall {
  return { id, name: "EnterWorktree", input };
}

describe("validateWorktreeName", () => {
  it("accepts simple and nested slugs within 64 chars", () => {
    expect(() => validateWorktreeName("feature")).not.toThrow();
    expect(() => validateWorktreeName("user/feature-foo")).not.toThrow();
    expect(() => validateWorktreeName("a.b_c-d")).not.toThrow();
    expect(() => validateWorktreeName("A".repeat(64))).not.toThrow();
  });

  it("rejects overlong names, empty segments, and path escapes", () => {
    expect(() => validateWorktreeName("A".repeat(65))).toThrow(/64 characters or fewer/);
    expect(() => validateWorktreeName("foo//bar")).toThrow(/non-empty/);
    expect(() => validateWorktreeName("/leading")).toThrow(/non-empty/);
    expect(() => validateWorktreeName("trailing/")).toThrow(/non-empty/);
    expect(() => validateWorktreeName("a/../b")).toThrow(/\.\./);
    expect(() => validateWorktreeName(".")).toThrow(/\./);
    expect(() => validateWorktreeName("bad name")).toThrow(/letters, digits/);
    expect(() => validateWorktreeName("has@sign")).toThrow(/letters, digits/);
  });
});

describe("generateWorktreeSlug", () => {
  it("emits a grammar-valid random slug", () => {
    const slug = generateWorktreeSlug();
    expect(slug.startsWith("wt-")).toBe(true);
    expect(() => validateWorktreeName(slug)).not.toThrow();
  });
});

describe("EnterWorktree tool", () => {
  beforeEach(() => {
    enterSessionWorktreeMock.mockClear();
  });

  afterEach(() => {
    enterSessionWorktreeMock.mockClear();
  });

  it("exposes the EnterWorktree schema name and input properties", () => {
    expect(EnterWorktree.schema.name).toBe("EnterWorktree");
    const props = EnterWorktree.schema.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("name");
    expect(props).toHaveProperty("path");
    expect(EnterWorktree.schema.inputSchema.additionalProperties).toBe(false);
  });

  it("rejects name and path together", async () => {
    const result = await EnterWorktree.run(call({ name: "feat", path: "/tmp/wt" }), ctx);
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("at most one of `name` or `path`");
    expect(enterSessionWorktreeMock).not.toHaveBeenCalled();
  });

  it("rejects invalid name grammar before calling the foundation", async () => {
    const result = await EnterWorktree.run(call({ name: "bad name" }), ctx);
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("Invalid worktree name");
    expect(enterSessionWorktreeMock).not.toHaveBeenCalled();
  });

  it("creates via enterSessionWorktree with the provided name", async () => {
    const result = await EnterWorktree.run(call({ name: "user/feature" }), ctx);
    expect(result.is_error).toBeUndefined();
    expect(enterSessionWorktreeMock).toHaveBeenCalledTimes(1);
    expect(enterSessionWorktreeMock.mock.calls[0]?.[1]).toEqual({ name: "user/feature" });
    const payload = JSON.parse(String(result.content)) as {
      worktreePath: string;
      worktreeBranch?: string;
      message: string;
    };
    expect(payload.worktreePath).toContain("user/feature");
    expect(payload.worktreeBranch).toBe("worktree-user/feature");
    expect(payload.message).toContain("Created");
  });

  it("generates a slug when neither name nor path is provided", async () => {
    const result = await EnterWorktree.run(call({}), ctx);
    expect(result.is_error).toBeUndefined();
    expect(enterSessionWorktreeMock).toHaveBeenCalledTimes(1);
    const opts = enterSessionWorktreeMock.mock.calls[0]?.[1] as { name?: string; path?: string };
    expect(opts.path).toBeUndefined();
    expect(typeof opts.name).toBe("string");
    expect(opts.name?.startsWith("wt-")).toBe(true);
    expect(() => validateWorktreeName(opts.name!)).not.toThrow();
  });

  it("enters an existing worktree via path (foundation validates git worktree list)", async () => {
    const result = await EnterWorktree.run(
      call({ path: "/repo/.otherside/worktrees/existing" }),
      ctx,
    );
    expect(result.is_error).toBeUndefined();
    expect(enterSessionWorktreeMock).toHaveBeenCalledWith(ctx, {
      path: "/repo/.otherside/worktrees/existing",
    });
    const payload = JSON.parse(String(result.content)) as { message: string };
    expect(payload.message).toContain("Entered existing");
  });

  it("surfaces foundation errors as tool errors", async () => {
    enterSessionWorktreeMock.mockImplementationOnce(() =>
      Promise.reject(new Error("session worktree: not inside a git repository")),
    );
    const result = await EnterWorktree.run(call({ name: "solo" }), ctx);
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("not inside a git repository");
  });

  it("trims whitespace on name and path", async () => {
    await EnterWorktree.run(call({ name: "  feat  " }), ctx);
    expect(enterSessionWorktreeMock.mock.calls[0]?.[1]).toEqual({ name: "feat" });

    enterSessionWorktreeMock.mockClear();
    await EnterWorktree.run(call({ path: "  /tmp/wt  " }), ctx);
    expect(enterSessionWorktreeMock.mock.calls[0]?.[1]).toEqual({ path: "/tmp/wt" });
  });
});
