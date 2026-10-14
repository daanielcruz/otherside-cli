import { describe, expect, it } from "bun:test";
import { measuredStamp } from "@/engine/session/record/measured-stamp.ts";
import { lineToRecords } from "@/engine/session/record/reader.ts";
import type { AssistantRequestUsage } from "@/engine/session/record/schema.ts";

// A main-turn Gemini stamp as a pre-1.2.0 release wrote it: the whole prompt from the
// frames before the cache figure, plus the cached share from the last frame.
const SUMMED: AssistantRequestUsage = {
  input_tokens: 478_023,
  output_tokens: 119,
  thought_tokens: 9,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 591_387,
  request_count: 1,
};

const OLD_MAIN_TURN = { version: "1.1.0", provider: "antigravity", sidechain: false };

describe("a usage stamp as what its request held", () => {
  it("reads a summed Antigravity main-turn stamp as the larger counter", () => {
    const read = measuredStamp(SUMMED, OLD_MAIN_TURN);
    expect(read.input_tokens + read.cache_read_input_tokens).toBe(591_387);
    expect(read).toEqual({ ...SUMMED, input_tokens: 0 });
  });

  it("keeps the fresh share when the whole prompt outweighs the cached share", () => {
    const read = measuredStamp(
      { ...SUMMED, input_tokens: 637_662, cache_read_input_tokens: 600_000 },
      OLD_MAIN_TURN,
    );
    expect(read.input_tokens).toBe(37_662);
    expect(read.input_tokens + read.cache_read_input_tokens).toBe(637_662);
  });

  it("leaves an uncached stamp as written", () => {
    const uncached = { ...SUMMED, cache_read_input_tokens: 0 };
    expect(measuredStamp(uncached, OLD_MAIN_TURN)).toBe(uncached);
  });

  it("covers every release before 1.2.0, prereleases included", () => {
    for (const version of ["0.9.2-pre", "1.0.0", "1.1.0"]) {
      expect(measuredStamp(SUMMED, { ...OLD_MAIN_TURN, version }).input_tokens).toBe(0);
    }
  });

  it("trusts what 1.2.0 and later wrote", () => {
    for (const version of ["1.2.0", "1.2.1", "1.10.0"]) {
      expect(measuredStamp(SUMMED, { ...OLD_MAIN_TURN, version })).toBe(SUMMED);
    }
  });

  it("trusts a line whose version cannot be read", () => {
    for (const version of [undefined, "", "test", 12]) {
      expect(measuredStamp(SUMMED, { ...OLD_MAIN_TURN, version })).toBe(SUMMED);
    }
  });

  it("trusts other providers and subagent turns, which never summed frames", () => {
    expect(measuredStamp(SUMMED, { ...OLD_MAIN_TURN, provider: "codex" })).toBe(SUMMED);
    expect(measuredStamp(SUMMED, { ...OLD_MAIN_TURN, sidechain: true })).toBe(SUMMED);
  });
});

describe("reading a transcript line", () => {
  function assistantLine(version: string, provider: string): string {
    return JSON.stringify({
      type: "assistant",
      uuid: "assistant-1",
      parentUuid: null,
      timestamp: "2026-10-13T07:41:35.118Z",
      sessionId: "session-fixture",
      cwd: "/Users/someone/project",
      version,
      message: {
        role: "assistant",
        model: "gemini-3.8-flash",
        content: [{ type: "text", text: "answer" }],
        usage: {
          input_tokens: SUMMED.input_tokens,
          output_tokens: SUMMED.output_tokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: SUMMED.cache_read_input_tokens,
        },
      },
      _os: {
        route: { provider, model: "gemini-3.8-flash" },
        provider,
        model: "gemini-3.8-flash",
        thoughtTokens: 9,
        requestCount: 1,
      },
    });
  }

  function usageOf(line: string): AssistantRequestUsage | undefined {
    const record = lineToRecords(line).find((r) => r.type === "assistant_message");
    return record?.type === "assistant_message" ? record.usage : undefined;
  }

  it("reads the stamp an older release wrote as what the request held", () => {
    expect(usageOf(assistantLine("1.1.0", "antigravity"))).toMatchObject({
      input_tokens: 0,
      cache_read_input_tokens: 591_387,
    });
  });

  it("reads a current stamp as written", () => {
    expect(usageOf(assistantLine("1.2.0", "antigravity"))).toMatchObject({
      input_tokens: 478_023,
      cache_read_input_tokens: 591_387,
    });
  });
});
