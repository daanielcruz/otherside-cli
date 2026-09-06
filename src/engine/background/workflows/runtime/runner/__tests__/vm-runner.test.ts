import { describe, expect, test } from "bun:test";
import type { Script } from "node:vm";
import { compileWorkflowProgram } from "@/engine/background/workflows/runtime/compiler/compile.ts";
import type { WorkflowVmContextOptions } from "@/engine/background/workflows/runtime/runner/context.ts";
import { runWorkflowVm } from "@/engine/background/workflows/runtime/runner/vm-runner.ts";
import { WORKFLOW_SCRIPT_FILENAME } from "@/engine/background/workflows/runtime/sandbox/errors.ts";

function compileBody(body: string): Script {
  const compiled = compileWorkflowProgram(body);
  if (!compiled.ok) throw new Error(`fixture failed to compile: ${compiled.error}`);
  return compiled.vmScript;
}

function run(body: string, options?: WorkflowVmContextOptions) {
  return runWorkflowVm(compileBody(body), options);
}

describe("runWorkflowVm: function return values are a hard error", () => {
  test("a bare function return fails the run", async () => {
    const result = await run("return () => {}");
    expect(result.error).toBe("workflow returned a function; return plain data");
    expect(result.result).toBeUndefined();
  });

  test("a function nested in the returned object also fails the run", async () => {
    const result = await run("return { ok: true, fn: () => 1 }");
    expect(result.error).toBe("workflow returned a function; return plain data");
  });

  test("plain data still returns normally", async () => {
    const result = await run("return { a: 1, b: [1, 2, 3] }");
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ a: 1, b: [1, 2, 3] });
  });
});

describe("runWorkflowVm: failure surfaces a short stack", () => {
  test("thrown script errors report the message plus frames in the compiled script", async () => {
    const result = await run(
      [
        "function boom() { throw new Error('kaboom'); }",
        "function mid() { boom(); }",
        "mid();",
      ].join("\n"),
    );
    expect(result.error).toBeDefined();
    const lines = (result.error as string).split("\n");
    expect(lines[0]).toBe("kaboom");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length).toBeLessThanOrEqual(4);
    for (const frame of lines.slice(1)) expect(frame).toContain(WORKFLOW_SCRIPT_FILENAME);
  });
});

describe("runWorkflowVm: log capture is capped at 1000 lines", () => {
  test("a chatty script stops accumulating logs past the cap", async () => {
    const result = await run(
      ["for (let i = 0; i < 1050; i++) { log(String(i)); }", "return 'done';"].join("\n"),
    );
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("done");
    expect(result.logs.length).toBe(1000);
    expect(result.logs[998]).toBe("998");
    expect(result.logs[999]).toBe("\u2026log capped at 1000 lines");
  });
});

describe("runWorkflowVm: host values are reified via structured clone at the boundary", () => {
  test("script mutation of args never reaches the host object", async () => {
    const hostArgs = { count: 1, nested: { flag: true } };
    const result = await run(
      [
        "const vmOwned = Object.getPrototypeOf(args) === Object.prototype;",
        "args.count = 999;",
        "args.nested.flag = false;",
        "return { count: args.count, vmOwned };",
      ].join("\n"),
      { args: hostArgs },
    );
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ count: 999, vmOwned: true });
    expect(hostArgs.count).toBe(1);
    expect(hostArgs.nested.flag).toBe(true);
  });

  test("agent() results are cloned into the VM realm, not aliased", async () => {
    const hostResult = { value: 1 };
    const result = await run(
      [
        "const r = await agent('x');",
        "const vmOwned = Object.getPrototypeOf(r) === Object.prototype && r.constructor === Object;",
        "r.value = 99;",
        "return { value: r.value, vmOwned };",
      ].join("\n"),
      {
        hooks: { agent: async () => hostResult },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ value: 99, vmOwned: true });
    expect(hostResult.value).toBe(1);
  });

  test("a BigInt field in an agent() result no longer crashes the run (JSON.stringify would throw)", async () => {
    const result = await run(["const r = await agent('x');", "return typeof r.big;"].join("\n"), {
      hooks: { agent: async () => ({ big: BigInt(10), ok: true }) },
    });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("bigint");
  });

  test("omitted args stays undefined instead of becoming null", async () => {
    const result = await run("return typeof args");
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("undefined");
  });
});

describe("runWorkflowVm: setTimeout callback exceptions are swallowed", () => {
  test("a throwing timer callback does not fail the run and is recorded as a log line", async () => {
    const result = await run(
      [
        "setTimeout(() => { throw new Error('timer boom'); }, 0);",
        "await new Promise((resolve) => setTimeout(resolve, 20));",
        "return 'survived';",
      ].join("\n"),
    );
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("survived");
    expect(result.logs.some((line) => line.includes("timer boom"))).toBe(true);
  });
});
