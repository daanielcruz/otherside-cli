import type {
  ProviderId,
  VoiceProviderId,
  VoiceProviderSelection,
} from "@/kernel/config/provider-ids.ts";
import { isVoiceProviderId } from "@/kernel/config/provider-ids.ts";

export interface VoiceTranscriberCallbacks {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
}

export interface VoiceTranscriber {
  readonly sampleRate: number;
  send(chunk: Buffer): void;
  finish(): Promise<string>;
  cancel(): void;
}

/** Optional transport options shared across providers. */
export interface VoiceConnectOptions {
  /** Resolved wire language code, or null/omit for server auto-detect where supported. */
  language?: string | null;
}

const LABELS: Record<VoiceProviderId, string> = {
  anthropic: "Anthropic",
  codex: "Codex",
  xai: "Grok",
  antigravity: "Gemini",
};

const SAMPLE_RATES: Record<VoiceProviderId, number> = {
  anthropic: 16_000,
  codex: 24_000,
  xai: 16_000,
  antigravity: 16_000,
};

export function voiceProviderLabel(provider: VoiceProviderId): string {
  return LABELS[provider];
}

export function voiceSampleRate(provider: VoiceProviderId): number {
  return SAMPLE_RATES[provider];
}

export function resolveVoiceProvider(
  selection: VoiceProviderSelection | undefined,
  currentProvider: ProviderId | string,
): VoiceProviderId | null {
  if (selection && selection !== "off") return selection;
  if (selection === "off") return null;
  return isVoiceProviderId(currentProvider) ? currentProvider : null;
}

export async function connectVoiceTranscriber(
  provider: VoiceProviderId,
  callbacks: VoiceTranscriberCallbacks,
  signal?: AbortSignal,
  options?: VoiceConnectOptions,
): Promise<VoiceTranscriber> {
  switch (provider) {
    case "anthropic":
      return (await import("@/engine/providers/anthropic/voice.ts")).connectVoice(
        callbacks,
        signal,
        options,
      );
    case "codex":
      return (await import("@/engine/providers/codex/voice.ts")).connectVoice(
        callbacks,
        signal,
        options,
      );
    case "xai":
      return (await import("@/engine/providers/xai/voice.ts")).connectVoice(
        callbacks,
        signal,
        options,
      );
    case "antigravity":
      return (await import("@/engine/providers/antigravity/voice.ts")).connectVoice(
        callbacks,
        signal,
      );
  }
}
