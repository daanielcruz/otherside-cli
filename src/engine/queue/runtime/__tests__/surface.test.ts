import { describe, expect, it } from "bun:test";
import {
  clampMemoryContent,
  formatRecallReminder,
  MAX_MEMORY_BYTES,
  MAX_MEMORY_LINES,
  memoryHeader,
} from "../surface.ts";

const DAY_MS = 86_400_000;

describe("memoryHeader", () => {
  it("uses the age header for a memory saved today", () => {
    expect(memoryHeader("/mem/a.md", Date.now())).toBe("Memory (saved today): /mem/a.md:");
  });

  it("uses the age header for a memory saved yesterday", () => {
    expect(memoryHeader("/mem/a.md", Date.now() - DAY_MS)).toBe(
      "Memory (saved yesterday): /mem/a.md:",
    );
  });

  it("uses the staleness preamble for an old memory", () => {
    const header = memoryHeader("/mem/a.md", Date.now() - 5 * DAY_MS);
    expect(header).toBe(
      "This memory is 5 days old. " +
        "Memories are point-in-time observations, not live state — " +
        "claims about code behavior or file:line citations may be outdated. " +
        "Verify against current code before asserting as fact." +
        "\n\nMemory: /mem/a.md:",
    );
  });
});

describe("clampMemoryContent", () => {
  it("returns short content unchanged", () => {
    const { content, truncated } = clampMemoryContent("hello\nworld", "/mem/a.md");
    expect(content).toBe("hello\nworld");
    expect(truncated).toBe(false);
  });

  it("truncates by line count with the line-limit note", () => {
    const raw = Array.from({ length: MAX_MEMORY_LINES + 10 }, (_, i) => `l${i}`).join("\n");
    const { content, truncated } = clampMemoryContent(raw, "/mem/long.md");
    expect(truncated).toBe(true);
    expect(content).toContain(`l${MAX_MEMORY_LINES - 1}`);
    expect(content).not.toContain(`l${MAX_MEMORY_LINES}\n`);
    expect(content).toEndWith(
      `\n\n> This memory file was truncated (first ${MAX_MEMORY_LINES} lines). Use the Read tool to view the complete file at: /mem/long.md`,
    );
  });

  it("truncates by byte budget with the byte-limit note", () => {
    const raw = "x".repeat(MAX_MEMORY_BYTES + 100);
    const { content, truncated } = clampMemoryContent(raw, "/mem/big.md");
    expect(truncated).toBe(true);
    expect(content).toEndWith(
      `\n\n> This memory file was truncated (${MAX_MEMORY_BYTES} byte limit). Use the Read tool to view the complete file at: /mem/big.md`,
    );
    const body = content.slice(0, content.indexOf("\n\n> This memory file was truncated"));
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(MAX_MEMORY_BYTES);
  });

  it("does not split a multibyte character at the byte cut", () => {
    const raw = "é".repeat(MAX_MEMORY_BYTES);
    const { content } = clampMemoryContent(raw, "/mem/utf8.md");
    expect(content).not.toContain("\uFFFD");
  });
});

describe("formatRecallReminder", () => {
  it("wraps header and content in a system-reminder block", () => {
    const reminder = formatRecallReminder({
      path: "/mem/a.md",
      content: "the content",
      mtimeMs: Date.now(),
      header: "Memory (saved today): /mem/a.md:",
    });
    expect(reminder).toBe(
      "<system-reminder>\nMemory (saved today): /mem/a.md:\n\nthe content\n</system-reminder>",
    );
  });
});
