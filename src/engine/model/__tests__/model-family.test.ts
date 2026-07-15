import { describe, expect, it } from "bun:test";
import {
  modelSupportsMidConversationSystem,
  modelSupportsMidConversationSystemBeta,
} from "@/engine/model/facts/model-family.ts";

describe("modelSupportsMidConversationSystemBeta", () => {
  const SUPPORTED = ["claude-opus-4-8", "claude-fable-5", "claude-sonnet-5"];
  const UNSUPPORTED = [
    "claude-opus-4-5",
    "claude-opus-4-7",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-3-5-sonnet-20241022",
  ];

  for (const base of SUPPORTED) {
    it(`grants the beta to ${base}`, () => {
      expect(modelSupportsMidConversationSystemBeta(base)).toBe(true);
    });
  }

  for (const base of UNSUPPORTED) {
    it(`withholds the beta from ${base}`, () => {
      expect(modelSupportsMidConversationSystemBeta(base)).toBe(false);
    });
  }
});

// Mid-system *blocks* stay opus/fable only; sonnet keeps user-message injections.
describe("modelSupportsMidConversationSystem", () => {
  const SUPPORTED = ["claude-opus-4-8", "claude-fable-5"];
  const UNSUPPORTED = [
    "claude-sonnet-5",
    "claude-opus-4-5",
    "claude-opus-4-7",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-3-5-sonnet-20241022",
  ];

  for (const base of SUPPORTED) {
    it(`assembles mid-system for ${base}`, () => {
      expect(modelSupportsMidConversationSystem(base)).toBe(true);
    });
  }

  for (const base of UNSUPPORTED) {
    it(`withholds mid-system blocks from ${base}`, () => {
      expect(modelSupportsMidConversationSystem(base)).toBe(false);
    });
  }
});
