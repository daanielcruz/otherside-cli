import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { parseWorkflowScript } from "@/engine/background/workflows/runtime/parser/meta.ts";
import {
  WORKFLOW_SCRIPT_MAX_BYTES,
  WorkflowParseError,
} from "@/engine/background/workflows/runtime/parser/types.ts";

function metaHeader(): string {
  return `export const meta = {\n  name: "t",\n  description: "d",\n}\n`;
}

describe("meta size gate", () => {
  test("measures UTF-16 length, not UTF-8 byte length", () => {
    // Each accented character is 1 UTF-16 code unit but 2 UTF-8 bytes, so this
    // script is under the code-unit cap but well over the byte cap.
    const padding = "\u00e9".repeat(300_000);
    const script = `${metaHeader()}// ${padding}\n`;
    expect(script.length).toBeLessThanOrEqual(WORKFLOW_SCRIPT_MAX_BYTES);
    expect(Buffer.byteLength(script, "utf8")).toBeGreaterThan(WORKFLOW_SCRIPT_MAX_BYTES);
    expect(() => parseWorkflowScript(script)).not.toThrow();
  });

  test("still rejects scripts over the UTF-16 length cap", () => {
    const script = `${metaHeader()}// ${"a".repeat(600_000)}\n`;
    expect(() => parseWorkflowScript(script)).toThrow(WorkflowParseError);
  });
});

describe("meta-first rule", () => {
  test("a leading empty statement before the meta export is a compile error", () => {
    const script = `;\n${metaHeader()}`;
    expect(() => parseWorkflowScript(script)).toThrow(/meta-first rule/);
  });

  test("an export declaration after meta is a compile error, not silently stripped", () => {
    const script = `${metaHeader()}export const helper = 1;\n`;
    expect(() => parseWorkflowScript(script)).toThrow(/meta-first rule/);
  });

  test("a normal script with only the meta export still parses", () => {
    const script = `${metaHeader()}const helper = 1;\nreturn helper;\n`;
    const parsed = parseWorkflowScript(script);
    expect(parsed.meta.name).toBe("t");
    expect(parsed.body.trim()).toBe("const helper = 1;\nreturn helper;");
  });
});
