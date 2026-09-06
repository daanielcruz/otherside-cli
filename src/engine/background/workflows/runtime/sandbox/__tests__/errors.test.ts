import { describe, expect, test } from "bun:test";
import {
  shortErrorStack,
  toSandboxError,
  WORKFLOW_SCRIPT_FILENAME,
  wrapSyncForVm,
} from "@/engine/background/workflows/runtime/sandbox/errors.ts";

describe("toSandboxError", () => {
  test("returns a null-prototype carrier, not a host Error instance", () => {
    const safe = toSandboxError(new Error("boom"));
    expect(Object.getPrototypeOf(safe)).toBeNull();
    expect(safe).not.toBeInstanceOf(Error);
    expect(safe.name).toBe("Error");
    expect(safe.message).toBe("boom");
    expect(Object.getPrototypeOf(safe.toString)).toBeNull();
    expect(String(safe)).toBe("Error: boom");
  });

  test("carries no prototype for plain string/object inputs either", () => {
    const safe = toSandboxError("plain failure");
    expect(Object.getPrototypeOf(safe)).toBeNull();
    expect(safe.message).toBe("plain failure");
  });

  test("wrapSyncForVm returns a null-prototype host wrapper", () => {
    const wrapped = wrapSyncForVm(() => "ok");
    expect(Object.getPrototypeOf(wrapped)).toBeNull();
    expect(wrapped()).toBe("ok");
  });
});

describe("shortErrorStack", () => {
  test("keeps the first message line plus up to 3 frames in the compiled script", () => {
    const error = new Error("boom");
    error.stack = [
      "Error: boom",
      `    at inner (${WORKFLOW_SCRIPT_FILENAME}:2:3)`,
      `    at outer (${WORKFLOW_SCRIPT_FILENAME}:5:1)`,
      "    at Object.<anonymous> (/some/host/file.ts:10:2)",
      `    at deepest (${WORKFLOW_SCRIPT_FILENAME}:1:1)`,
      `    at extra (${WORKFLOW_SCRIPT_FILENAME}:1:1)`,
    ].join("\n");

    const short = shortErrorStack(error);
    const lines = short.split("\n");
    expect(lines[0]).toBe("boom");
    expect(lines.length).toBe(4);
    for (const line of lines.slice(1)) expect(line).toContain(WORKFLOW_SCRIPT_FILENAME);
    // The host frame must never appear, even though it sits before the cap.
    expect(short).not.toContain("host/file.ts");
  });

  test("falls back to just the message when there is no matching stack frame", () => {
    expect(shortErrorStack(new Error("no frames here"))).toBe("no frames here");
    expect(shortErrorStack("plain string error")).toBe("plain string error");
  });
});
