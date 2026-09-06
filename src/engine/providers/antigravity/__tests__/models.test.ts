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
