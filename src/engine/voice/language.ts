import type { VoiceProviderId } from "@/kernel/config/provider-ids.ts";

const PROVIDER_LABELS: Record<VoiceProviderId, string> = {
  anthropic: "Anthropic",
  codex: "Codex",
  xai: "Grok",
  antigravity: "Gemini",
};

/** Result of normalizing a user preference before per-provider routing. */
export type NormalizedDictationLanguage = {
  /** ISO-639-1 (or fil) code, or null to let the server auto-detect. */
  code: string | null;
  /** Original preference when it was non-empty but could not be resolved. */
  fellBackFrom?: string;
};

/** Per-provider wire decision after allowlist/catalog clamping. */
export type RoutedDictationLanguage = {
  /**
   * Value for the wire. `null` means omit the field (Codex auto-detect).
   * Anthropic and Grok always produce a concrete code (default `en`).
   */
  wireCode: string | null;
  fellBackFrom?: string;
  /** Resolved code that this provider does not support and clamped to English. */
  clampedFrom?: string;
};

const LANGUAGE_NAME_TO_CODE: Record<string, string> = {
  english: "en",
  spanish: "es",
  español: "es",
  espanol: "es",
  french: "fr",
  français: "fr",
  francais: "fr",
  japanese: "ja",
  日本語: "ja",
  german: "de",
  deutsch: "de",
  portuguese: "pt",
  português: "pt",
  portugues: "pt",
  italian: "it",
  italiano: "it",
  korean: "ko",
  한국어: "ko",
  hindi: "hi",
  हिन्दी: "hi",
  हिंदी: "hi",
  indonesian: "id",
  "bahasa indonesia": "id",
  bahasa: "id",
  russian: "ru",
  русский: "ru",
  polish: "pl",
  polski: "pl",
  turkish: "tr",
  türkçe: "tr",
  turkce: "tr",
  dutch: "nl",
  nederlands: "nl",
  ukrainian: "uk",
  українська: "uk",
  greek: "el",
  ελληνικά: "el",
  czech: "cs",
  čeština: "cs",
  cestina: "cs",
  danish: "da",
  dansk: "da",
  swedish: "sv",
  svenska: "sv",
  norwegian: "no",
  norsk: "no",
  arabic: "ar",
  filipino: "fil",
  tagalog: "fil",
  macedonian: "mk",
  malay: "ms",
  persian: "fa",
  farsi: "fa",
  romanian: "ro",
  thai: "th",
  vietnamese: "vi",
};

function isBareLanguageCode(value: string): boolean {
  // ISO-639-1 (2 letters) plus the multi-letter codes we explicitly support.
  return /^[a-z]{2}$/.test(value) || value === "fil";
}

/** Anthropic voice_stream server allowlist (20). Outside → 1008 close. */
export const ANTHROPIC_DICTATION_LANGUAGES = new Set([
  "en",
  "es",
  "fr",
  "ja",
  "de",
  "pt",
  "it",
  "ko",
  "hi",
  "id",
  "ru",
  "pl",
  "tr",
  "nl",
  "uk",
  "el",
  "cs",
  "da",
  "sv",
  "no",
]);

/** Grok STT language catalog (25). */
export const GROK_DICTATION_LANGUAGES = new Set([
  "ar",
  "cs",
  "da",
  "nl",
  "en",
  "fil",
  "fr",
  "de",
  "hi",
  "id",
  "it",
  "ja",
  "ko",
  "mk",
  "ms",
  "fa",
  "pl",
  "pt",
  "ro",
  "ru",
  "es",
  "sv",
  "th",
  "tr",
  "vi",
]);

function primarySubtag(tag: string): string {
  const cleaned = tag.trim().toLowerCase();
  // Strip encoding / modifiers: "pt_BR.UTF-8" → "pt_br"
  const base = cleaned.split(".")[0] ?? cleaned;
  const primary = base.split(/[-_]/)[0] ?? base;
  return primary;
}

function resolveSystemLocale(systemLocale?: string): string | null {
  const candidates =
    systemLocale !== undefined
      ? [systemLocale]
      : [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG];
  for (const candidate of candidates) {
    if (!candidate || candidate === "C" || candidate === "POSIX") continue;
    const primary = primarySubtag(candidate);
    if (!primary || primary === "c") continue;
    if (primary === "tl") return "fil";
    if (isBareLanguageCode(primary)) return primary;
  }
  return null;
}

/**
 * Normalize a dictation-language preference to an ISO-639-1 (or `fil`) code.
 * `"auto"` / unset resolves from the system locale; unresolved explicit values
 * return `{ code: null, fellBackFrom }`.
 */
export function normalizeDictationLanguage(
  preference: string | undefined,
  systemLocale?: string,
): NormalizedDictationLanguage {
  const raw = preference?.trim();
  if (!raw || raw.toLowerCase() === "auto") {
    return { code: resolveSystemLocale(systemLocale) };
  }

  const lower = raw.toLowerCase();
  if (lower === "tl") return { code: "fil" };
  if (isBareLanguageCode(lower)) return { code: lower };

  const fromName = LANGUAGE_NAME_TO_CODE[lower];
  if (fromName) return { code: fromName };

  // Region tags: pt-BR / pt_BR / pt_br → pt
  const primary = primarySubtag(lower);
  if (primary === "tl") return { code: "fil" };
  if (isBareLanguageCode(primary)) return { code: primary };

  return preference ? { code: null, fellBackFrom: preference } : { code: null };
}

export function clampAnthropicDictationLanguage(code: string | null): {
  wireCode: string;
  clampedFrom?: string;
} {
  if (code && ANTHROPIC_DICTATION_LANGUAGES.has(code)) return { wireCode: code };
  if (code) return { wireCode: "en", clampedFrom: code };
  return { wireCode: "en" };
}

export function clampGrokDictationLanguage(code: string | null): {
  wireCode: string;
  clampedFrom?: string;
} {
  if (code && GROK_DICTATION_LANGUAGES.has(code)) return { wireCode: code };
  if (code) return { wireCode: "en", clampedFrom: code };
  return { wireCode: "en" };
}

/**
 * Route a preference through normalization and the active provider's allowlist.
 * Gemini ignores language; Codex never clamps.
 */
export function routeDictationLanguage(
  provider: VoiceProviderId,
  preference: string | undefined,
  systemLocale?: string,
): RoutedDictationLanguage {
  const normalized = normalizeDictationLanguage(preference, systemLocale);
  const base: RoutedDictationLanguage = {
    wireCode: normalized.code ?? "en",
    ...(normalized.fellBackFrom ? { fellBackFrom: normalized.fellBackFrom } : {}),
  };

  switch (provider) {
    case "anthropic": {
      const clamped = clampAnthropicDictationLanguage(normalized.code);
      return {
        ...base,
        wireCode: clamped.wireCode,
        ...(clamped.clampedFrom ? { clampedFrom: clamped.clampedFrom } : {}),
      };
    }
    case "xai": {
      const clamped = clampGrokDictationLanguage(normalized.code);
      return {
        ...base,
        wireCode: clamped.wireCode,
        ...(clamped.clampedFrom ? { clampedFrom: clamped.clampedFrom } : {}),
      };
    }
    case "codex":
      return base;
    case "antigravity":
      return base;
  }
}

/** Diagnosis-only messages for unsupported preferences / provider clamps. */
export function dictationLanguageFallbackMessage(value: string): string {
  return `"${value}" is not a supported dictation language; using English.`;
}

export function dictationLanguageClampMessage(code: string, provider: VoiceProviderId): string {
  return `Dictation language "${code}" is not supported by ${PROVIDER_LABELS[provider]}; using English.`;
}
