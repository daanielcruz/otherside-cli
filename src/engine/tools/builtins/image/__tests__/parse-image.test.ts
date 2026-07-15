import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NON_VISION_IMAGE_PLACEHOLDER } from "@/engine/model/facts/capabilities.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import type { ToolResultContentBlock } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  canReplayToolResultImagesNatively,
  resolveToolResultImagesForNonVision,
} from "../parse-image.ts";

registerAllProviders();

// Isolated config dir keeps the tests hermetic: a developer's real
// imageParserProvider setting would otherwise trigger live network calls.
let base: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "otherside-parse-image-test-"));
  savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = join(base, "config");
});

afterEach(() => {
  if (savedConfigDir === undefined) {
    delete process.env.OTHERSIDE_CONFIG_DIR;
  } else {
    process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
  }
  rmSync(base, { recursive: true, force: true });
});

describe("resolveToolResultImagesForNonVision", () => {
  it("replays tool-result images natively only for providers that support that position", () => {
    expect(
      canReplayToolResultImagesNatively({
        provider: "anthropic",
        model: "claude-3-opus-20240229",
        effort: null,
        permissionMode: "default",
        sessionId: "test-session",
        cwd: "/tmp",
      }),
    ).toBe(true);
    expect(
      canReplayToolResultImagesNatively({
        provider: "glm",
        model: "glm-5.2",
        effort: null,
        permissionMode: "default",
        sessionId: "test-session",
        cwd: "/tmp",
      }),
    ).toBe(false);
  });

  it("returns blocks unchanged if the provider supports native vision", async () => {
    const ctx: RequestContext = {
      provider: "anthropic",
      model: "claude-3-opus-20240229",
      effort: null,
      permissionMode: "default",
      sessionId: "test-session",
      cwd: "/tmp",
    };

    const blocks: ToolResultContentBlock[] = [
      { type: "text", text: "Hello" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "SGVsbG8=",
        },
      },
    ];

    const result = await resolveToolResultImagesForNonVision(ctx, blocks);
    expect(result).toBe(blocks);
  });

  it("translates or redacts image blocks if the provider does not support native vision", async () => {
    const ctx: RequestContext = {
      provider: "deepseek",
      model: "deepseek-coder",
      effort: null,
      permissionMode: "default",
      sessionId: "test-session",
      cwd: "/tmp",
    };

    const blocks: ToolResultContentBlock[] = [
      { type: "text", text: "Some text" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "SGVsbG8=",
        },
      },
      { type: "tool_reference", tool_name: "Bash" },
    ];

    const result = await resolveToolResultImagesForNonVision(ctx, blocks);
    expect(result).not.toBe(blocks);
    expect(result).toEqual([
      { type: "text", text: "Some text" },
      {
        type: "text",
        text: NON_VISION_IMAGE_PLACEHOLDER,
      },
      { type: "tool_reference", tool_name: "Bash" },
    ]);
  });
});
