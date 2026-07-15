import { describe, expect, test } from "bun:test";
import {
  cloneWorkflowBoundaryResult,
  cloneWorkflowBoundaryValue,
  MAX_BOUNDARY_ARRAY_LENGTH,
} from "@/engine/background/workflows/runtime/sandbox/clone.ts";

describe("cloneWorkflowBoundaryResult", () => {
  test("reports no function for plain data", () => {
    const { value, hasFunction } = cloneWorkflowBoundaryResult({ a: 1, b: [1, 2, "x"] });
    expect(hasFunction).toBe(false);
    expect(value).toEqual({ a: 1, b: [1, 2, "x"] });
  });

  test("reports a function at the top level", () => {
    const { hasFunction } = cloneWorkflowBoundaryResult(() => 1);
    expect(hasFunction).toBe(true);
  });

  test("reports a function nested inside an object", () => {
    const { hasFunction } = cloneWorkflowBoundaryResult({ ok: true, fn: () => 1 });
    expect(hasFunction).toBe(true);
  });

  test("reports a function nested inside an array", () => {
    const { hasFunction } = cloneWorkflowBoundaryResult([1, 2, () => 1]);
    expect(hasFunction).toBe(true);
  });

  test("rejects an array above the boundary limit instead of truncating it", () => {
    const oversized = Array.from({ length: MAX_BOUNDARY_ARRAY_LENGTH + 1 }, () => 1);
    expect(() => cloneWorkflowBoundaryValue(oversized)).toThrow(
      `array length ${MAX_BOUNDARY_ARRAY_LENGTH + 1} exceeds the maximum`,
    );
  });

  test("propagates a nested array-limit error through object cloning", () => {
    const oversized = Array.from({ length: MAX_BOUNDARY_ARRAY_LENGTH + 1 }, () => 1);
    expect(() => cloneWorkflowBoundaryValue({ nested: oversized })).toThrow(
      `array length ${MAX_BOUNDARY_ARRAY_LENGTH + 1} exceeds the maximum`,
    );
  });

  test("rejects a non-safe array length from a proxy", () => {
    const invalidLength = new Proxy([], {
      get(target, key, receiver) {
        return key === "length" ? Number.MAX_SAFE_INTEGER + 1 : Reflect.get(target, key, receiver);
      },
    });
    expect(() => cloneWorkflowBoundaryValue(invalidLength)).toThrow(
      "array length is not a safe integer",
    );
  });
});
