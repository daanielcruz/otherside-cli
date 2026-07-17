import { describe, expect, it } from "bun:test";
import {
  clampAnthropicDictationLanguage,
  clampGrokDictationLanguage,
  dictationLanguageClampMessage,
  dictationLanguageFallbackMessage,
  normalizeDictationLanguage,
  routeDictationLanguage,
} from "@/engine/voice/language.ts";

describe("normalizeDictationLanguage", () => {
  it("maps region tags and bare codes to the primary subtag", () => {
    expect(normalizeDictationLanguage("pt_BR")).toEqual({ code: "pt" });
    expect(normalizeDictationLanguage("pt-BR")).toEqual({ code: "pt" });
    expect(normalizeDictationLanguage("pt_br")).toEqual({ code: "pt" });
    expect(normalizeDictationLanguage("pt")).toEqual({ code: "pt" });
  });

  it("maps English and native language names", () => {
    expect(normalizeDictationLanguage("português")).toEqual({ code: "pt" });
    expect(normalizeDictationLanguage("portuguese")).toEqual({ code: "pt" });
    expect(normalizeDictationLanguage("日本語")).toEqual({ code: "ja" });
    expect(normalizeDictationLanguage("Español")).toEqual({ code: "es" });
  });

  it("aliases tl to fil", () => {
    expect(normalizeDictationLanguage("tl")).toEqual({ code: "fil" });
    expect(normalizeDictationLanguage("tagalog")).toEqual({ code: "fil" });
    expect(normalizeDictationLanguage("filipino")).toEqual({ code: "fil" });
  });

  it("resolves auto from an explicit system locale", () => {
    expect(normalizeDictationLanguage("auto", "pt_BR.UTF-8")).toEqual({ code: "pt" });
    expect(normalizeDictationLanguage(undefined, "ja_JP.UTF-8")).toEqual({ code: "ja" });
    expect(normalizeDictationLanguage("", "es-MX")).toEqual({ code: "es" });
  });

  it("returns null when auto has no locale", () => {
    expect(normalizeDictationLanguage("auto", "")).toEqual({ code: null });
    expect(normalizeDictationLanguage("auto", "C")).toEqual({ code: null });
    expect(normalizeDictationLanguage(undefined, "POSIX")).toEqual({ code: null });
  });

  it("returns fellBackFrom for unresolvable explicit preferences", () => {
    expect(normalizeDictationLanguage("garbage")).toEqual({
      code: null,
      fellBackFrom: "garbage",
    });
    expect(normalizeDictationLanguage("not-a-language")).toEqual({
      code: null,
      fellBackFrom: "not-a-language",
    });
  });
});

describe("per-provider dictation language routing", () => {
  it("clamps Anthropic to English for codes outside the allowlist", () => {
    expect(clampAnthropicDictationLanguage("vi")).toEqual({
      wireCode: "en",
      clampedFrom: "vi",
    });
    expect(clampAnthropicDictationLanguage("pt")).toEqual({ wireCode: "pt" });
    expect(clampAnthropicDictationLanguage(null)).toEqual({ wireCode: "en" });
  });

  it("keeps Grok catalog codes and clamps unknown to English", () => {
    expect(clampGrokDictationLanguage("vi")).toEqual({ wireCode: "vi" });
    expect(clampGrokDictationLanguage("el")).toEqual({
      wireCode: "en",
      clampedFrom: "el",
    });
    expect(clampGrokDictationLanguage(null)).toEqual({ wireCode: "en" });
  });

  it("routes vi to Anthropic as en with clamp, Grok as vi, Codex as vi", () => {
    expect(routeDictationLanguage("anthropic", "vi", "")).toEqual({
      wireCode: "en",
      clampedFrom: "vi",
    });
    expect(routeDictationLanguage("xai", "vi", "")).toEqual({ wireCode: "vi" });
    expect(routeDictationLanguage("codex", "vi", "")).toEqual({ wireCode: "vi" });
  });

  it("defaults the wire language to English when auto is unresolved", () => {
    expect(routeDictationLanguage("codex", "auto", "")).toEqual({ wireCode: "en" });
    expect(routeDictationLanguage("codex", "garbage", "")).toEqual({
      wireCode: "en",
      fellBackFrom: "garbage",
    });
  });

  it("never clamps on Codex and keeps Gemini's route stable", () => {
    expect(routeDictationLanguage("codex", "el", "")).toEqual({ wireCode: "el" });
    expect(routeDictationLanguage("antigravity", "vi", "")).toEqual({ wireCode: "vi" });
  });

  it("builds diagnosis-only warning messages", () => {
    expect(dictationLanguageFallbackMessage("zzz")).toBe(
      '"zzz" is not a supported dictation language; using English.',
    );
    expect(dictationLanguageClampMessage("vi", "anthropic")).toBe(
      'Dictation language "vi" is not supported by Anthropic; using English.',
    );
    expect(dictationLanguageClampMessage("el", "xai")).toBe(
      'Dictation language "el" is not supported by Grok; using English.',
    );
  });
});
