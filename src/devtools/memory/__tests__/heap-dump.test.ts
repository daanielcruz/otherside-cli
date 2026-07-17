import { describe, expect, it } from "bun:test";
import { captureHeapDiagnostics } from "../heap-dump.ts";

describe("captureHeapDiagnostics", () => {
  it("reports a live memory snapshot with derived native bytes and array warnings", () => {
    const d = captureHeapDiagnostics("manual");
    expect(d.trigger).toBe("manual");
    expect(d.rss).toBeGreaterThan(0);
    expect(d.heapUsed).toBeGreaterThan(0);
    expect(d.nativeBytes).toBe(d.rss - d.heapUsed);
    expect(d.bytesPerSecond).toBeGreaterThanOrEqual(0);
    expect(d.approxMbPerHour).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(d.warnings)).toBe(true);
    expect(Array.isArray(d.potentialLeaks)).toBe(true);
    expect(typeof d.recommendation).toBe("string");
    expect(typeof d.platform).toBe("string");
    expect(typeof d.nodeVersion).toBe("string");
    expect(typeof d.othersideVersion).toBe("string");
    expect(d).toHaveProperty("mallocedMemory");
    expect(d).toHaveProperty("peakMallocedMemory");
    expect(d).toHaveProperty("nativeContexts");
    expect(d).toHaveProperty("resourceUsage");
    expect(d).toHaveProperty("smapsRollup");
    expect(d).toHaveProperty("objectTypeCounts");
    expect(d).toHaveProperty("protectedObjectTypeCounts");
    expect(d).toHaveProperty("mimalloc");
    if (d.resourceUsage !== undefined) {
      expect(d.resourceUsage.maxRSS).toBeGreaterThan(0);
      expect(d.resourceUsage.userCPUTime).toBeGreaterThanOrEqual(0);
      expect(d.resourceUsage.systemCPUTime).toBeGreaterThanOrEqual(0);
    }
  });
});
