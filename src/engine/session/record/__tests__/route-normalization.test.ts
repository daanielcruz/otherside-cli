import { describe, expect, it } from "bun:test";
import { normalizeRecordRoute } from "@/engine/session/record/schema.ts";

describe("record route normalization", () => {
  it("forms a route from the separate fields a record written before routes carries", () => {
    expect(normalizeRecordRoute({ provider: "anthropic", model: "claude-opus-5" })).toEqual({
      route: { provider: "anthropic", model: "claude-opus-5" },
      provider: "anthropic",
      model: "claude-opus-5",
    });
  });

  it("lets an explicit route settle a disagreement with the separate fields", () => {
    expect(
      normalizeRecordRoute({
        route: { provider: "codex", model: "gpt-5.6-sol" },
        provider: "anthropic",
        model: "claude-opus-5",
      }),
    ).toEqual({
      route: { provider: "codex", model: "gpt-5.6-sol" },
      provider: "codex",
      model: "gpt-5.6-sol",
    });
  });

  it("keeps what it was given when the pair is incomplete", () => {
    // A model with no provider names nothing on its own, so no route is invented.
    expect(normalizeRecordRoute({ model: "claude-opus-5" })).toEqual({
      model: "claude-opus-5",
    });
    expect(normalizeRecordRoute({ provider: "anthropic" })).toEqual({
      provider: "anthropic",
    });
    expect(normalizeRecordRoute({})).toEqual({});
  });

  it("refuses a provider it does not recognise rather than forming a false route", () => {
    expect(normalizeRecordRoute({ provider: "retired-provider", model: "some-model" })).toEqual({
      provider: "retired-provider",
      model: "some-model",
    });
  });
});
