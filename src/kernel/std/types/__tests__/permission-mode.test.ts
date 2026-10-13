import { describe, expect, it } from "bun:test";
import { parsePermissionMode } from "@/kernel/std/types/permission-mode.ts";

describe("parsePermissionMode", () => {
  it("accepts every current mode as itself", () => {
    expect(parsePermissionMode("default")).toBe("default");
    expect(parsePermissionMode("accept-edits")).toBe("accept-edits");
    expect(parsePermissionMode("yolo")).toBe("yolo");
  });

  it("reads a stored plan mode as the asking mode", () => {
    expect(parsePermissionMode("plan")).toBe("default");
  });

  it("rejects anything else", () => {
    expect(parsePermissionMode("garbage")).toBeUndefined();
    expect(parsePermissionMode(undefined)).toBeUndefined();
    expect(parsePermissionMode(3)).toBeUndefined();
  });
});
