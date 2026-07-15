import { describe, expect, it } from "bun:test";
import type { ToolCall } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { ReportFindings } from "../report-findings.ts";

const mockCtx: RequestContext = {
  provider: "anthropic",
  model: "claude-sonnet-5",
  effort: null,
  permissionMode: "default",
  sessionId: "test-sess",
  cwd: "/tmp",
};

describe("ReportFindings tool handler", () => {
  it("returns 'No findings reported.' when findings array is empty", async () => {
    const call: ToolCall = {
      id: "call-1",
      name: "ReportFindings",
      input: { findings: [] },
    };
    const result = await ReportFindings.run(call, mockCtx);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe("No findings reported.");
  });

  it("returns '1 finding reported.' when findings array has 1 item", async () => {
    const call: ToolCall = {
      id: "call-2",
      name: "ReportFindings",
      input: {
        findings: [
          {
            file: "src/main.ts",
            line: 10,
            summary: "Null pointer exception",
            failure_scenario: "Run code",
          },
        ],
      },
    };
    const result = await ReportFindings.run(call, mockCtx);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe("1 finding reported.");
  });

  it("returns '2 findings reported.' when findings array has 2 items", async () => {
    const call: ToolCall = {
      id: "call-3",
      name: "ReportFindings",
      input: {
        findings: [
          {
            file: "src/main.ts",
            line: 10,
            summary: "Null pointer exception",
            failure_scenario: "Run code",
          },
          {
            file: "src/index.ts",
            line: 20,
            summary: "Unused variable",
            failure_scenario: "Lint code",
          },
        ],
      },
    };
    const result = await ReportFindings.run(call, mockCtx);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe("2 findings reported.");
  });

  it("returns error when findings is missing", async () => {
    const call: ToolCall = {
      id: "call-4",
      name: "ReportFindings",
      input: {},
    };
    const result = await ReportFindings.run(call, mockCtx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("required");
  });

  it("returns error when findings is not an array", async () => {
    const call: ToolCall = {
      id: "call-5",
      name: "ReportFindings",
      input: { findings: "not-an-array" },
    };
    const result = await ReportFindings.run(call, mockCtx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("must be an array");
  });
});
