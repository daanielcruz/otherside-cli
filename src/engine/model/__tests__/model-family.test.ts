import { describe, expect, it } from "bun:test";
import {
  modelSupportsMidConversationSystem,
  modelSupportsMidConversationSystemBeta,
} from "@/engine/model/facts/model-family.ts";

// Haiku is denylisted: the API rejects mid-conversation system roles on it, so
// it keeps reminders in user blocks and omits the beta; everyone else promotes.
describe("modelSupportsMidConversationSystemBeta", () => {
  const GRANTED = [
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-fable-5",
    "claude-sonnet-5",
    "claude-opus-4-5",
    "claude-opus-4-7",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
  ];

  for (const base of GRANTED) {
    it(`grants the beta to ${base}`, () => {
      expect(modelSupportsMidConversationSystemBeta(base)).toBe(true);
    });
  }

  it("withholds the beta from claude-haiku-4-5", () => {
    expect(modelSupportsMidConversationSystemBeta("claude-haiku-4-5")).toBe(false);
  });
});

// The unwrap set stays opus-5/opus-4-8/fable only; everyone else promotes
// keeping the reminder wrapper.
describe("modelSupportsMidConversationSystem", () => {
  const SUPPORTED = ["claude-opus-5", "claude-opus-4-8", "claude-fable-5"];
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
