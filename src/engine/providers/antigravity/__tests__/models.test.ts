import { describe, expect, it } from "bun:test";
import { config, MODELS } from "../config.ts";
import { resolveAntigravityModel } from "../models.ts";

describe("model catalog and request selection", () => {
  it("offers the current Flash families and keeps the configured default", () => {
    expect(MODELS.filter((model) => model.id.includes("flash")).map((model) => model.id)).toEqual([
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
    ]);
    expect(config.defaultModelId).toBe("gemini-3.8-flash");
  });

  it.each([
    "gemini-4-argon",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-3.8-flash",
  ])("keeps all effort variants for %s", (model) => {
    for (const effort of ["low", "medium", "high"] as const) {
      expect(resolveAntigravityModel(model, effort).wireModel).toBe(`${model}-${effort}`);
      expect(resolveAntigravityModel(`${model}-${effort}`)).toEqual(
        resolveAntigravityModel(model, effort),
      );
    }
  });

  it("maps Gemini 4 Argon efforts to thinkingLevel LOW/MEDIUM/HIGH with medium as default", () => {
    expect(resolveAntigravityModel("gemini-4-argon")).toMatchObject({
      wireModel: "gemini-4-argon-medium",
      thinkingLevel: "MEDIUM",
      modelEnum: "MODEL_PLACEHOLDER_M418",
    });
    expect(resolveAntigravityModel("gemini-4-argon", "low")).toMatchObject({
      wireModel: "gemini-4-argon-low",
      thinkingLevel: "LOW",
      modelEnum: "MODEL_PLACEHOLDER_M419",
    });
    expect(resolveAntigravityModel("gemini-4-argon", "high")).toMatchObject({
      wireModel: "gemini-4-argon-high",
      thinkingLevel: "HIGH",
      modelEnum: "MODEL_PLACEHOLDER_M417",
    });
  });

  it.each([
    "gemini-3-flash",
    "gemini-3-flash-low",
    "gemini-3-flash-medium",
    "gemini-3.5-flash",
    "gemini-3.5-flash-low",
    "gemini-3.5-flash-medium",
    "gemini-3.5-flash-high",
    "custom-model-fixture",
  ])("passes unregistered model %s through without an alias", (model) => {
    expect(MODELS.some((entry) => entry.id === model)).toBe(false);
    expect(resolveAntigravityModel(model, "low")).toEqual({
      ...resolveAntigravityModel("gemini-3.6-flash", "high"),
      wireModel: model,
    });
  });
});
