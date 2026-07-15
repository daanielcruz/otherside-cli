import { describe, expect, it } from "bun:test";
import {
  type AllocLeverDeps,
  createAllocLeverGuard,
  isSystemHeapActive,
} from "@/devtools/memory/allocator.ts";

type ExecveCall = {
  file: string;
  args: string[];
  env: Record<string, string | undefined>;
};

function makeDeps(overrides: Partial<AllocLeverDeps> = {}): {
  deps: AllocLeverDeps;
  calls: ExecveCall[];
} {
  const calls: ExecveCall[] = [];
  const deps: AllocLeverDeps = {
    platform: "darwin",
    env: { OTHERSIDE_ALLOC_LEVER: "1", HOME: "/Users/x" },
    execPath: "/Users/x/.local/bin/otherside",
    argv: ["bun", "/$bunfs/root/main.js", "--yolo", "-c"],
    argv0: "/Users/x/.local/bin/otherside",
    execve: (file, args, env) => {
      calls.push({ file, args, env });
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("createAllocLeverGuard", () => {
  it("re-execs with Malloc + marker injected and user args preserved", () => {
    const { deps, calls } = makeDeps();
    createAllocLeverGuard(deps)();
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.file).toBe("/Users/x/.local/bin/otherside");
    expect(call.args).toEqual(["/Users/x/.local/bin/otherside", "--yolo", "-c"]);
    expect(call.env.Malloc).toBe("1");
    expect(call.env.OTHERSIDE_ALLOC_LEVER_DONE).toBe("1");
    expect(call.env.HOME).toBe("/Users/x");
  });

  it("does nothing without the opt-in", () => {
    const { deps, calls } = makeDeps({ env: { HOME: "/Users/x" } });
    createAllocLeverGuard(deps)();
    expect(calls).toHaveLength(0);
  });

  it("does nothing when the re-exec marker is already set", () => {
    const { deps, calls } = makeDeps({
      env: { OTHERSIDE_ALLOC_LEVER: "1", OTHERSIDE_ALLOC_LEVER_DONE: "1" },
    });
    createAllocLeverGuard(deps)();
    expect(calls).toHaveLength(0);
  });

  it("does nothing when the opt-out is set", () => {
    const { deps, calls } = makeDeps({
      env: { OTHERSIDE_ALLOC_LEVER: "1", OTHERSIDE_NO_ALLOC_LEVER: "1" },
    });
    createAllocLeverGuard(deps)();
    expect(calls).toHaveLength(0);
  });

  it("respects a pre-existing Malloc* env var regardless of value", () => {
    const { deps, calls } = makeDeps({
      env: { OTHERSIDE_ALLOC_LEVER: "1", MallocScribble: "0" },
    });
    createAllocLeverGuard(deps)();
    expect(calls).toHaveLength(0);
  });

  it("skips the dev (non-compiled) runtime", () => {
    const { deps, calls } = makeDeps({ execPath: "/opt/homebrew/bin/bun" });
    createAllocLeverGuard(deps)();
    expect(calls).toHaveLength(0);
  });

  it("skips win32", () => {
    const { deps, calls } = makeDeps({ platform: "win32" });
    createAllocLeverGuard(deps)();
    expect(calls).toHaveLength(0);
  });

  it("skips a runtime without execve", () => {
    const { deps } = makeDeps({ execve: undefined });
    expect(() => createAllocLeverGuard(deps)()).not.toThrow();
  });

  it("survives a throwing execve without propagating", () => {
    const { deps } = makeDeps({
      execve: () => {
        throw new Error("exec failed");
      },
    });
    expect(() => createAllocLeverGuard(deps)()).not.toThrow();
  });
});

describe("isSystemHeapActive", () => {
  it("detects any Malloc* var regardless of value", () => {
    expect(isSystemHeapActive({ Malloc: "1" })).toBe(true);
    expect(isSystemHeapActive({ MallocScribble: "0" })).toBe(true);
    expect(isSystemHeapActive({ HOME: "/x" })).toBe(false);
  });
});
