import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getTrackedCwd, setTrackedCwd } from "@/kernel/std/state/cwd-state.ts";
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

// Spread the real module first: a partial mock surface poisons the module
// registry for every later test file in the same run (imports of unlisted
// exports fail to load), so only the members under test are overridden.
const realWorktreeModule = await import("@/engine/session/worktree.ts");
mock.module("@/engine/session/worktree.ts", () => ({
  ...realWorktreeModule,
  attachSessionWorktreeHost: mock(() => {}),
  enterSessionWorktree: enterSessionWorktreeMock,
  exitSessionWorktree: mock(() => Promise.resolve({})),
  getActiveWorktree: mock(() => null),
  isPinnedCwdContext: mock(() => false),
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

let previousTrackedCwd: string;

beforeEach(() => {
  previousTrackedCwd = getTrackedCwd();
});

afterEach(() => {
  setTrackedCwd(previousTrackedCwd);
});

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
    expect(() => validateWorktreeName(".git")).toThrow(/reserved git directory/);
    expect(() => validateWorktreeName("nested/.GIT...")).toThrow(/reserved git directory/);
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
    expect(result.content).toContain("Created worktree user/feature");
    expect(getTrackedCwd()).toBe("/tmp/worktrees/user/feature");
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
    expect(result.content).toContain("Entered existing");
  });

  it("surfaces foundation errors as tool errors", async () => {
    enterSessionWorktreeMock.mockImplementationOnce(() =>
      Promise.reject(new Error("session worktree: not inside a git repository")),
    );
    const result = await EnterWorktree.run(call({ name: "solo" }), ctx);
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("not inside a git repository");
  });

  it("does not trim model-authored names or paths", async () => {
    const invalidName = await EnterWorktree.run(call({ name: "  feat  " }), ctx);
    expect(invalidName.is_error).toBe(true);
    expect(enterSessionWorktreeMock).not.toHaveBeenCalled();

    await EnterWorktree.run(call({ path: "  /tmp/wt  " }), ctx);
    expect(enterSessionWorktreeMock.mock.calls[0]?.[1]).toEqual({ path: "  /tmp/wt  " });
  });
});
