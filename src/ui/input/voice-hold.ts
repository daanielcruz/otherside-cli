import { type AudioCapture, startAudioCapture } from "@/engine/voice/capture.ts";
import {
  connectVoiceTranscriber,
  resolveVoiceProvider,
  type VoiceTranscriber,
  voiceSampleRate,
} from "@/engine/voice/index.ts";
import {
  dictationLanguageClampMessage,
  dictationLanguageFallbackMessage,
  routeDictationLanguage,
} from "@/engine/voice/language.ts";
import { loadConfigSync } from "@/kernel/config/config.ts";
import type { VoiceProviderId } from "@/kernel/std/types/provider-ids.ts";
import { setVoicePhase, submitVoiceError } from "@/store/app-store/right-region-notices.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { TerminalColor } from "@/terminal-runtime/text/style-model.ts";
import { readStringViewBrokerState } from "@/ui/chrome/status/string-view-state.ts";

export type VoicePhase = "idle" | "warmup" | "recording" | "processing";

interface Anchor {
  before: string;
  after: string;
}

export interface VoicePreview {
  text: string;
  cursor: number;
  // Start of the inserted transcript; the prompt dims [transcriptStart,
  // cursor) so interim dictation reads as provisional next to typed text.
  transcriptStart: number;
}

/** The meter cell drawn in place of the prompt caret while recording. */
export interface VoiceMeterCell {
  char: string;
  color: TerminalColor;
}

export interface VoiceHoldIo {
  buffer(): string;
  cursor(): number;
  apply(text: string, cursor: number): void;
  submit(text: string): void;
  requestRender(): void;
}

export interface VoiceHoldServices {
  connect: typeof connectVoiceTranscriber;
  startCapture: typeof startAudioCapture;
  resolveRoute: () => { provider: VoiceProviderId | null; language: string | undefined };
}

function defaultResolveRoute(): { provider: VoiceProviderId | null; language: string | undefined } {
  const cfg = loadConfigSync();
  return {
    provider: resolveVoiceProvider(cfg.voiceProvider, readStringViewBrokerState().provider),
    language: cfg.language,
  };
}

const defaultServices: VoiceHoldServices = {
  connect: connectVoiceTranscriber,
  startCapture: startAudioCapture,
  resolveRoute: defaultResolveRoute,
};

// While a voice phase is active the prompt's voice handler owns Escape
// (cancel capture, keep the buffer); the global cancel ladder must yield.
export const voiceCaptureActiveRef = { current: false };

// Space push-to-talk thresholds: terminal key repeats stand in for key-up
// events, so a hold is detected by counting repeats and a release by their
// absence. The first presses type normally and are stripped when the hold
// engages, keeping plain space typing intact.
const HOLD_MIN_PRESSES = 5;
const HOLD_HINT_PRESSES = 2;
const KEY_RELEASE_DEBOUNCE_MS = 120;
const DOUBLE_TAP_SUBMIT_MS = 300;
// Empty transcripts from holds shorter than this are accidental taps and
// return to idle silently; only longer holds warn about missing speech.
const EMPTY_TRANSCRIPT_WARN_MS = 2_000;
// Capture level callbacks are throttled so the meter repaints at a steady
// cadence instead of per audio chunk.
const LEVEL_THROTTLE_MS = 45;

const METER_CHARS = " ▂▃▄▅▆▇█";
const METER_SMOOTHING = 0.7;
const METER_SCALE = 1.8;
const METER_SILENCE_THRESHOLD = 0.15;
const METER_FRAME_MS = 50;
const METER_HUE_DEGREES_PER_SECOND = 90;
const METER_SILENCE_COLOR = "#808080" as const;

/** Hue wheel color for the live meter cell; constant chroma over a grey base. */
export function voiceMeterColor(hue: number): `#${string}` {
  const normalizedHue = ((hue % 360) + 360) % 360;
  const chroma = 0.56;
  const x = chroma * (1 - Math.abs(((normalizedHue / 60) % 2) - 1));
  const offset = 0.32;
  let red = 0;
  let green = 0;
  let blue = 0;
  if (normalizedHue < 60) {
    red = chroma;
    green = x;
  } else if (normalizedHue < 120) {
    red = x;
    green = chroma;
  } else if (normalizedHue < 180) {
    green = chroma;
    blue = x;
  } else if (normalizedHue < 240) {
    green = x;
    blue = chroma;
  } else if (normalizedHue < 300) {
    red = x;
    blue = chroma;
  } else {
    red = chroma;
    blue = x;
  }
  const channel = (value: number): number => Math.round((value + offset) * 255);
  return `#${[channel(red), channel(green), channel(blue)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function insertVoiceTranscript(anchor: Anchor, rawTranscript: string): VoicePreview {
  const transcript = rawTranscript.trim();
  if (!transcript) {
    return {
      text: anchor.before + anchor.after,
      cursor: anchor.before.length,
      transcriptStart: anchor.before.length,
    };
  }
  const leftSpace = anchor.before.length > 0 && !/\s$/.test(anchor.before) ? " " : "";
  const rightSpace = anchor.after.length > 0 && !/^\s/.test(anchor.after) ? " " : "";
  const inserted = `${leftSpace}${transcript}${rightSpace}`;
  return {
    text: anchor.before + inserted + anchor.after,
    cursor: anchor.before.length + leftSpace.length + transcript.length,
    transcriptStart: anchor.before.length + leftSpace.length,
  };
}

/**
 * Space push-to-talk for the prompt: press counting engages a hold, key
 * repeats sustain it, and their absence within the debounce window is the
 * release. Owns the capture/transcriber lifecycle and exposes the preview,
 * meter cell, and phase the prompt renders from.
 */
export class VoiceHold {
  private phaseValue: VoicePhase = "idle";
  private level = 0;
  private transcript = "";
  private anchor: Anchor | null = null;
  private capture: AudioCapture | null = null;
  private transcriber: VoiceTranscriber | null = null;
  private abort: AbortController | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private burstTimer: ReturnType<typeof setTimeout> | null = null;
  private doubleTapTimer: ReturnType<typeof setTimeout> | null = null;
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private meterLevel = 0;
  private meterStartedAt = 0;
  private awaitingSubmit = false;
  private firstSubmitTap = 0;
  private finishRequested = false;
  private recordingStartedAt = 0;
  private lastLevelAt = 0;
  private pressCount = 0;
  private typedSpaces = 0;
  // Diagnosis warnings fire once per session so capture start stays quiet after.
  private warnedFallback = false;
  private warnedClamp = false;

  constructor(
    private readonly io: VoiceHoldIo,
    private readonly services: VoiceHoldServices = defaultServices,
  ) {}

  phase(): VoicePhase {
    return this.phaseValue;
  }

  preview(): VoicePreview | null {
    if (!this.anchor || !this.transcript) return null;
    return insertVoiceTranscript(this.anchor, this.transcript);
  }

  /** Meter cell shown in the caret's place; null outside the recording phase. */
  meterCell(): VoiceMeterCell | null {
    if (this.phaseValue !== "recording") return null;
    const charIndex = Math.max(
      1,
      Math.min(Math.round(this.meterLevel * (METER_CHARS.length - 1)), METER_CHARS.length - 1),
    );
    return {
      char: METER_CHARS[charIndex] ?? METER_CHARS[1] ?? " ",
      color:
        this.level < METER_SILENCE_THRESHOLD
          ? METER_SILENCE_COLOR
          : voiceMeterColor(
              ((Date.now() - this.meterStartedAt) / 1000) * METER_HUE_DEGREES_PER_SECOND,
            ),
    };
  }

  dispose(): void {
    this.cancel();
    if (this.doubleTapTimer) clearTimeout(this.doubleTapTimer);
    this.doubleTapTimer = null;
    if (this.burstTimer) clearTimeout(this.burstTimer);
    this.burstTimer = null;
  }

  /**
   * One key resolved against the hold machine. True consumes the key; false
   * lets the prompt handle it (the first presses of a burst type normally).
   */
  handleKey(key: KeyEventData, opts: { slashOpen: boolean; suspended: boolean }): boolean {
    if (key.name === "escape" && this.phaseValue !== "idle") {
      this.cancel();
      this.resetBurst();
      return true;
    }
    const sequence = key.sequence ?? "";
    const plainSpace =
      !key.ctrl &&
      !key.meta &&
      !key.shift &&
      !key.isPasted &&
      key.name !== "tab" &&
      key.name !== "return" &&
      sequence.length > 0 &&
      /^ +$/.test(sequence);
    if (!plainSpace || opts.slashOpen || opts.suspended) {
      if (!plainSpace) {
        if (this.awaitingSubmit) this.clearAwaitingSubmit();
        this.resetBurst();
      }
      return false;
    }
    const repeat = sequence.length;

    // Engaged hold: space repeats keep the recording alive and are swallowed.
    // A repeat proves the hold is still down, so it also cancels a deferred
    // finish requested by a debounce that fired while the event loop was
    // blocked (timers run before the queued stdin events on resume).
    if (this.anchor && (this.phaseValue === "warmup" || this.phaseValue === "recording")) {
      this.finishRequested = false;
      this.armRelease(KEY_RELEASE_DEBOUNCE_MS);
      return true;
    }

    // Post-transcript double-tap submit (only with the cursor at the end).
    if (this.awaitingSubmit && this.phaseValue === "idle") {
      if (this.doubleTapTimer) {
        // A further press while a submit is deferred proves a hold, not a
        // tap: drop the pending submit and let the burst engage the hold.
        this.clearAwaitingSubmit();
      } else if (this.io.cursor() !== this.io.buffer().length) {
        this.clearAwaitingSubmit();
      } else {
        const now = Date.now();
        if (this.firstSubmitTap > 0 && now - this.firstSubmitTap <= DOUBLE_TAP_SUBMIT_MS) {
          this.firstSubmitTap = 0;
          // Deferred so an immediately-following hold aborts the submit.
          this.doubleTapTimer = setTimeout(() => {
            this.doubleTapTimer = null;
            if (!this.awaitingSubmit || this.phaseValue !== "idle") return;
            this.awaitingSubmit = false;
            let text = this.io.buffer();
            if (text.endsWith(" ")) text = text.slice(0, -1);
            this.io.submit(text);
            this.io.apply("", 0);
          }, KEY_RELEASE_DEBOUNCE_MS);
          return true;
        }
        this.firstSubmitTap = now;
        // The first tap types a space and joins the burst below.
      }
    }

    const prevCount = this.pressCount;
    this.pressCount += repeat;
    this.armBurstTimer();

    if (this.phaseValue !== "recording" && this.pressCount >= HOLD_MIN_PRESSES) {
      if (this.phaseValue !== "idle" && !(this.phaseValue === "warmup" && !this.anchor)) {
        return true;
      }
      this.clearAwaitingSubmit();
      if (this.burstTimer) clearTimeout(this.burstTimer);
      this.burstTimer = null;
      this.stripTrailingSpacesAtCursor(this.typedSpaces + repeat, 0);
      this.pressCount = 0;
      this.typedSpaces = 0;
      if (this.phaseValue === "warmup") this.updatePhase("idle");
      void this.begin();
      return true;
    }

    // Presses past the hint threshold are swallowed instead of typed; each
    // also sweeps one stray trailing space down to this burst's typed floor.
    if (prevCount >= HOLD_HINT_PRESSES) {
      this.stripTrailingSpacesAtCursor(repeat, this.typedSpaces);
      return true;
    }
    this.typedSpaces += repeat;
    if (this.phaseValue === "idle" && this.pressCount >= HOLD_HINT_PRESSES) {
      this.updatePhase("warmup");
    }
    return false;
  }

  private updatePhase(next: VoicePhase): void {
    this.phaseValue = next;
    voiceCaptureActiveRef.current = next !== "idle";
    setVoicePhase(next);
    this.syncMeterClock();
    this.io.requestRender();
  }

  /** 50 ms repaint clock while recording; smooths the raw level between frames. */
  private syncMeterClock(): void {
    if (this.phaseValue === "recording") {
      if (this.meterTimer) return;
      this.meterLevel = 0;
      this.meterStartedAt = Date.now();
      this.meterTimer = setInterval(() => {
        const normalized = Math.min(this.level * METER_SCALE, 1);
        this.meterLevel = this.meterLevel * METER_SMOOTHING + normalized * (1 - METER_SMOOTHING);
        this.io.requestRender();
      }, METER_FRAME_MS);
      return;
    }
    if (this.meterTimer) {
      clearInterval(this.meterTimer);
      this.meterTimer = null;
    }
  }

  private clearReleaseTimer(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }

  private showMessage(value: string): void {
    submitVoiceError(value);
  }

  private cancel(): void {
    this.clearReleaseTimer();
    this.finishRequested = false;
    this.capture?.stop();
    this.capture = null;
    this.transcriber?.cancel();
    this.transcriber = null;
    this.abort?.abort();
    this.abort = null;
    this.transcript = "";
    this.level = 0;
    this.anchor = null;
    this.updatePhase("idle");
  }

  private async finish(): Promise<void> {
    if (this.phaseValue === "processing" || this.phaseValue === "idle") return;
    this.clearReleaseTimer();
    this.finishRequested = false;
    const recordingDurationMs =
      this.phaseValue === "recording" ? Date.now() - this.recordingStartedAt : 0;
    this.updatePhase("processing");
    this.capture?.stop();
    this.capture = null;
    const transcriber = this.transcriber;
    this.transcriber = null;
    let finalText = this.transcript;
    try {
      if (transcriber) finalText = await transcriber.finish();
    } catch (error) {
      this.showMessage(error instanceof Error ? error.message : String(error));
    }
    const anchor = this.anchor;
    if (anchor && finalText.trim()) {
      const inserted = insertVoiceTranscript(anchor, finalText);
      this.io.apply(inserted.text, inserted.cursor);
      this.awaitingSubmit = true;
      this.firstSubmitTap = 0;
    } else if (!finalText.trim() && recordingDurationMs > EMPTY_TRANSCRIPT_WARN_MS) {
      this.showMessage("No speech detected.");
    }
    this.abort = null;
    this.anchor = null;
    this.transcript = "";
    this.level = 0;
    this.updatePhase("idle");
  }

  private armRelease(delay: number): void {
    this.clearReleaseTimer();
    this.releaseTimer = setTimeout(() => {
      // Released before the transcriber connected: defer the finish so the
      // buffered audio still reaches it instead of being dropped.
      if (this.phaseValue !== "idle" && this.phaseValue !== "processing" && !this.transcriber) {
        this.finishRequested = true;
        return;
      }
      void this.finish();
    }, delay);
  }

  private async begin(): Promise<void> {
    const route = this.services.resolveRoute();
    const provider = route.provider;
    if (!provider || this.phaseValue !== "idle") return;
    this.awaitingSubmit = false;
    this.firstSubmitTap = 0;
    const buffer = this.io.buffer();
    const cursor = this.io.cursor();
    this.anchor = { before: buffer.slice(0, cursor), after: buffer.slice(cursor) };
    this.transcript = "";
    this.finishRequested = false;
    const routed = routeDictationLanguage(provider, route.language, "");
    if (routed.fellBackFrom && !this.warnedFallback) {
      this.warnedFallback = true;
      this.showMessage(dictationLanguageFallbackMessage(routed.fellBackFrom));
    }
    if (routed.clampedFrom && !this.warnedClamp) {
      this.warnedClamp = true;
      this.showMessage(dictationLanguageClampMessage(routed.clampedFrom, provider));
    }
    // The hold is sustained by space key repeats; absence of the next repeat
    // within the debounce window is the release.
    this.armRelease(KEY_RELEASE_DEBOUNCE_MS);
    const abort = new AbortController();
    this.abort = abort;
    const pendingChunks: Buffer[] = [];
    try {
      this.capture = this.services.startCapture(
        voiceSampleRate(provider),
        (chunk) => {
          if (this.transcriber) this.transcriber.send(chunk);
          else pendingChunks.push(chunk);
        },
        (nextLevel) => {
          const now = Date.now();
          if (now - this.lastLevelAt >= LEVEL_THROTTLE_MS) {
            this.lastLevelAt = now;
            this.level = nextLevel;
          }
        },
        (message) => this.showMessage(message),
      );
      // Recording starts with the microphone, not the transcriber: the level
      // meter goes live immediately while chunks buffer until the connect
      // resolves.
      this.recordingStartedAt = Date.now();
      this.updatePhase("recording");
      const transcriber = await this.services.connect(
        provider,
        {
          onInterim: (text) => {
            this.transcript = text;
            this.io.requestRender();
          },
          onFinal: (text) => {
            this.transcript = text;
            this.io.requestRender();
          },
          onError: (message) => this.showMessage(message),
        },
        abort.signal,
        { language: routed.wireCode },
      );
      if (abort.signal.aborted) {
        transcriber.cancel();
        return;
      }
      this.transcriber = transcriber;
      for (const chunk of pendingChunks) transcriber.send(chunk);
      pendingChunks.length = 0;
      if (this.finishRequested) void this.finish();
    } catch (error) {
      const aborted = abort.signal.aborted;
      this.cancel();
      if (!aborted) this.showMessage(error instanceof Error ? error.message : String(error));
    }
  }

  private clearDoubleTapTimer(): void {
    if (this.doubleTapTimer) clearTimeout(this.doubleTapTimer);
    this.doubleTapTimer = null;
  }

  private clearAwaitingSubmit(): void {
    this.awaitingSubmit = false;
    this.firstSubmitTap = 0;
    this.clearDoubleTapTimer();
  }

  private resetBurst(): void {
    if (this.burstTimer) clearTimeout(this.burstTimer);
    this.burstTimer = null;
    this.pressCount = 0;
    this.typedSpaces = 0;
    if (this.phaseValue === "warmup" && !this.anchor) this.updatePhase("idle");
  }

  private armBurstTimer(): void {
    if (this.burstTimer) clearTimeout(this.burstTimer);
    this.burstTimer = setTimeout(() => this.resetBurst(), KEY_RELEASE_DEBOUNCE_MS);
  }

  // Remove up to `count` spaces immediately before the cursor, never digging
  // below `floor` remaining. Counting actual buffer spaces (not press
  // bookkeeping) lets the sweep absorb a stray space typed by the initial
  // press of an earlier burst — the key-repeat delay outlives the burst
  // debounce, so that press's counter is already gone.
  private stripTrailingSpacesAtCursor(count: number, floor: number): void {
    const buffer = this.io.buffer();
    const cursor = this.io.cursor();
    let spaces = 0;
    while (spaces < cursor && buffer[cursor - spaces - 1] === " ") spaces += 1;
    const strip = Math.max(0, Math.min(spaces - floor, count));
    if (strip > 0) {
      this.io.apply(buffer.slice(0, cursor - strip) + buffer.slice(cursor), cursor - strip);
    }
  }
}
