import { describe, expect, it } from "bun:test";
import { mergeRosterOverlays, parseRosterOverlay } from "@/engine/model/tier/roster-overlay.ts";

describe("parseRosterOverlay", () => {
  it("parses tiers with rank order preserved", () => {
    const overlay = parseRosterOverlay(
      JSON.stringify({
        tiers: {
          emperor: [
            { provider: "anthropic", model: "claude-fable-5" },
            { provider: "codex", model: "gpt-5.6-sol" },
          ],
        },
      }),
    );
    expect(overlay.emperor).toEqual([
      { provider: "anthropic", model: "claude-fable-5" },
      { provider: "codex", model: "gpt-5.6-sol" },
    ]);
    expect(overlay.shogun).toBeUndefined();
  });

  it("keeps an explicit empty tier as an override", () => {
    const overlay = parseRosterOverlay(JSON.stringify({ tiers: { samurai: [] } }));
    expect(overlay.samurai).toEqual([]);
  });

  it("drops malformed entries and keeps the valid remainder", () => {
    const overlay = parseRosterOverlay(
      JSON.stringify({
        tiers: {
          daimyo: [
            { provider: "not-a-provider", model: "x" },
            { provider: "codex" },
            { provider: "codex", model: "  " },
            { provider: "codex", model: "gpt-5.6-luna" },
            "junk",
          ],
        },
      }),
    );
    expect(overlay.daimyo).toEqual([{ provider: "codex", model: "gpt-5.6-luna" }]);
  });

  it("degrades corrupt or shapeless JSON to an empty overlay", () => {
    expect(parseRosterOverlay("{not json")).toEqual({});
    expect(parseRosterOverlay(JSON.stringify(null))).toEqual({});
    expect(parseRosterOverlay(JSON.stringify({ tiers: "nope" }))).toEqual({});
    expect(parseRosterOverlay(JSON.stringify({ tiers: { unknown: [] } }))).toEqual({});
  });
});

describe("mergeRosterOverlays", () => {
  it("project tier replaces the user tier; absent tiers fall through", () => {
    const user = {
      emperor: [{ provider: "anthropic", model: "claude-fable-5" } as const],
      samurai: [{ provider: "glm", model: "glm-5-turbo" } as const],
    };
    const project = {
      emperor: [{ provider: "codex", model: "gpt-5.6-sol" } as const],
    };
    const merged = mergeRosterOverlays(user, project);
    expect(merged.emperor).toEqual([{ provider: "codex", model: "gpt-5.6-sol" }]);
    expect(merged.samurai).toEqual([{ provider: "glm", model: "glm-5-turbo" }]);
  });
});
