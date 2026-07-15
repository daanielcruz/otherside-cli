import { describe, expect, it } from "bun:test";
import { captureHeapDiagnostics } from "../heap-dump.ts";

describe("captureHeapDiagnostics", () => {
  it("reports a live memory snapshot with derived native bytes and array warnings", () => {
    const d = captureHeapDiagnostics("manual");
    expect(d.trigger).toBe("manual");
    expect(d.rss).toBeGreaterThan(0);
    expect(d.heapUsed).toBeGreaterThan(0);
    expect(d.nativeBytes).toBe(d.rss - d.heapUsed);
    expect(d.approxMbPerHour).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(d.warnings)).toBe(true);
  });
});
