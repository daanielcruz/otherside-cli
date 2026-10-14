import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  allTimeUsageByProvider,
  allTimeUsageByProviderAsync,
} from "@/engine/session/usage/store.ts";
import { statsCachePath } from "@/kernel/std/fs/paths.ts";

describe("all-time usage from session files", () => {
  const base = join(
    tmpdir(),
    `otherside-usage-store-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const configDir = join(base, "config");
  const ephemeralDir = join(base, "ephemeral");
  let savedConfigDir: string | undefined;
  let savedEphemeral: string | undefined;

  beforeEach(() => {
    savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    savedEphemeral = process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = configDir;
    process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = ephemeralDir;
    rmSync(base, { recursive: true, force: true });
    mkdirSync(ephemeralDir, { recursive: true });
    const projectDir = join(configDir, "projects", "test-project");
    mkdirSync(projectDir, { recursive: true });
    const line = JSON.stringify({
      type: "usage",
      ts: "2026-07-02T10:00:02.000Z",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      session_id: "s1",
      uuid: "u-parity-1",
      request_count: 1,
      input_tokens: 500,
      output_tokens: 100,
      thought_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    writeFileSync(join(projectDir, "s1.jsonl"), `${line}\n`, "utf8");
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
    if (savedEphemeral === undefined) delete process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
    else process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = savedEphemeral;
    rmSync(base, { recursive: true, force: true });
  });

  it("async and sync fold the same provider totals from session files", async () => {
    const syncTotals = allTimeUsageByProvider();
    // Wipe the stats cache so the async path re-folds rather than reading the
    // cache the sync path just wrote (still same end result either way, but
    // this exercises the fold path in both variants).
    rmSync(join(configDir, "usage"), { recursive: true, force: true });
    const asyncTotals = await allTimeUsageByProviderAsync();
    expect(asyncTotals).toEqual(syncTotals);
    expect(syncTotals.anthropic?.inputTokens).toBe(500);
    expect(syncTotals.anthropic?.outputTokens).toBe(100);
  });

  it("folds an older release's summed stamp again instead of keeping its cached total", () => {
    const sessionPath = join(configDir, "projects", "test-project", "s2.jsonl");
    writeFileSync(
      sessionPath,
      `${JSON.stringify({
        type: "assistant",
        uuid: "old-gemini-turn",
        parentUuid: null,
        timestamp: "2026-10-13T07:41:35.118Z",
        sessionId: "s2",
        version: "1.1.0",
        message: {
          role: "assistant",
          model: "gemini-3.8-flash",
          content: [{ type: "text", text: "answer" }],
          usage: {
            input_tokens: 478_023,
            output_tokens: 119,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 591_387,
          },
        },
        _os: {
          route: { provider: "antigravity", model: "gemini-3.8-flash" },
          provider: "antigravity",
          model: "gemini-3.8-flash",
          requestCount: 1,
        },
      })}\n`,
      "utf8",
    );
    // A cache from before the reader corrected such stamps, still matching the file.
    const stale = {
      version: 3,
      updatedAt: "2026-10-13T08:00:00.000Z",
      sessions: {
        s2: {
          mtime: statSync(sessionPath).mtimeMs,
          foldedBytes: statSync(sessionPath).size,
          tailUuids: ["old-gemini-turn"],
          usage: {
            antigravity: {
              requestCount: 1,
              inputTokens: 478_023,
              outputTokens: 119,
              thoughtTokens: 0,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 591_387,
            },
          },
        },
      },
    };
    mkdirSync(dirname(statsCachePath()), { recursive: true });
    writeFileSync(statsCachePath(), JSON.stringify(stale), "utf8");

    const totals = allTimeUsageByProvider();

    expect(totals.antigravity?.inputTokens).toBe(0);
    expect(totals.antigravity?.cacheReadInputTokens).toBe(591_387);
  });
});
