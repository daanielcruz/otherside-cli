import { type MutableRefObject, useEffect, useRef, useState } from "react";
import { type AudioCapture, startAudioCapture } from "@/engine/voice/capture.ts";
import {
  connectVoiceTranscriber,
  type VoiceTranscriber,
  voiceSampleRate,
} from "@/engine/voice/index.ts";
import {
  dictationLanguageClampMessage,
  dictationLanguageFallbackMessage,
  routeDictationLanguage,
} from "@/engine/voice/language.ts";
import type { Key } from "@/ink";
import type { VoiceProviderId } from "@/kernel/config/provider-ids.ts";
import { setVoicePhase, submitVoiceError } from "@/store/app-store/right-region-notices.ts";

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

export interface VoiceInputState {
  phase: VoicePhase;
  level: number;
  message: string | null;
  preview: VoicePreview | null;
}

export interface VoiceInputServices {
  connect: typeof connectVoiceTranscriber;
  startCapture: typeof startAudioCapture;
}

const defaultServices: VoiceInputServices = {
  connect: connectVoiceTranscriber,
  startCapture: startAudioCapture,
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

export function useVoiceInput(
  args: {
    provider: VoiceProviderId | null;
    language?: string | undefined;
    bufferRef: MutableRefObject<string>;
    cursorRef: MutableRefObject<number>;
    setBuffer: (value: string) => void;
    setCursor: (value: number) => void;
    onSubmit: (value: string) => void;
    suspended: boolean;
  },
  services: VoiceInputServices = defaultServices,
): {
  state: VoiceInputState;
  handleKey: (input: string, key: Key, slashOpen: boolean) => boolean;
} {
  const { provider, language, bufferRef, cursorRef, setBuffer, setCursor, onSubmit, suspended } =
    args;
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [level, setLevel] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const transcriptRef = useRef("");
  const phaseRef = useRef<VoicePhase>("idle");
  const anchorRef = useRef<Anchor | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const transcriberRef = useRef<VoiceTranscriber | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const awaitingSubmitRef = useRef(false);
  const firstSubmitTapRef = useRef(0);
  const finishRequestedRef = useRef(false);
  const recordingStartRef = useRef(0);
  const lastLevelAtRef = useRef(0);
  const pressCountRef = useRef(0);
  const typedSpacesRef = useRef(0);
  const burstTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doubleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Diagnosis warnings fire once per session so capture start stays quiet after.
  const warnedFallbackRef = useRef(false);
  const warnedClampRef = useRef(false);

  const updatePhase = (next: VoicePhase): void => {
    phaseRef.current = next;
    voiceCaptureActiveRef.current = next !== "idle";
    setPhase(next);
    setVoicePhase(next);
  };
  const clearReleaseTimer = (): void => {
    if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = null;
  };
  const showMessage = (value: string): void => {
    setMessage(value);
    submitVoiceError(value);
    if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    // Local prompt message still clears; right-region owns the 10s ephemeral.
    messageTimerRef.current = setTimeout(() => setMessage(null), 3_000);
  };
  const updateTranscript = (value: string): void => {
    transcriptRef.current = value;
    setTranscript(value);
  };

  const cancel = (): void => {
    clearReleaseTimer();
    finishRequestedRef.current = false;
    captureRef.current?.stop();
    captureRef.current = null;
    transcriberRef.current?.cancel();
    transcriberRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    updateTranscript("");
    setLevel(0);
    anchorRef.current = null;
    updatePhase("idle");
  };

  const finish = async (): Promise<void> => {
    if (phaseRef.current === "processing" || phaseRef.current === "idle") return;
    clearReleaseTimer();
    finishRequestedRef.current = false;
    const recordingDurationMs =
      phaseRef.current === "recording" ? Date.now() - recordingStartRef.current : 0;
    updatePhase("processing");
    captureRef.current?.stop();
    captureRef.current = null;
    const transcriber = transcriberRef.current;
    transcriberRef.current = null;
    let finalText = transcriptRef.current;
    try {
      if (transcriber) finalText = await transcriber.finish();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : String(error));
    }
    const anchor = anchorRef.current;
    if (anchor && finalText.trim()) {
      const inserted = insertVoiceTranscript(anchor, finalText);
      setBuffer(inserted.text);
      setCursor(inserted.cursor);
      awaitingSubmitRef.current = true;
      firstSubmitTapRef.current = 0;
    } else if (!finalText.trim() && recordingDurationMs > EMPTY_TRANSCRIPT_WARN_MS) {
      showMessage("No speech detected.");
    }
    abortRef.current = null;
    anchorRef.current = null;
    updateTranscript("");
    setLevel(0);
    updatePhase("idle");
  };

  const armRelease = (delay: number): void => {
    clearReleaseTimer();
    releaseTimerRef.current = setTimeout(() => {
      // Released before the transcriber connected: defer the finish so the
      // buffered audio still reaches it instead of being dropped.
      if (
        phaseRef.current !== "idle" &&
        phaseRef.current !== "processing" &&
        !transcriberRef.current
      ) {
        finishRequestedRef.current = true;
        return;
      }
      void finish();
    }, delay);
  };

  const begin = async (): Promise<void> => {
    if (!provider || suspended || phaseRef.current !== "idle") return;
    awaitingSubmitRef.current = false;
    firstSubmitTapRef.current = 0;
    const buffer = bufferRef.current;
    const cursor = cursorRef.current;
    anchorRef.current = { before: buffer.slice(0, cursor), after: buffer.slice(cursor) };
    updateTranscript("");
    finishRequestedRef.current = false;
    const routed = routeDictationLanguage(provider, language, "");
    if (routed.fellBackFrom && !warnedFallbackRef.current) {
      warnedFallbackRef.current = true;
      showMessage(dictationLanguageFallbackMessage(routed.fellBackFrom));
    }
    if (routed.clampedFrom && !warnedClampRef.current) {
      warnedClampRef.current = true;
      showMessage(dictationLanguageClampMessage(routed.clampedFrom, provider));
    }
    // The hold is sustained by space key repeats; absence of the next repeat
    // within the debounce window is the release.
    armRelease(KEY_RELEASE_DEBOUNCE_MS);
    const abort = new AbortController();
    abortRef.current = abort;
    const pendingChunks: Buffer[] = [];
    try {
      captureRef.current = services.startCapture(
        voiceSampleRate(provider),
        (chunk) => {
          const transcriber = transcriberRef.current;
          if (transcriber) transcriber.send(chunk);
          else pendingChunks.push(chunk);
        },
        (nextLevel) => {
          const now = Date.now();
          if (now - lastLevelAtRef.current >= 45) {
            lastLevelAtRef.current = now;
            setLevel(nextLevel);
          }
        },
        showMessage,
      );
      // Recording starts with the microphone, not the transcriber: the level
      // meter goes live immediately while chunks buffer until the connect
      // resolves.
      recordingStartRef.current = Date.now();
      updatePhase("recording");
      const transcriber = await services.connect(
        provider,
        {
          onInterim: updateTranscript,
          onFinal: updateTranscript,
          onError: showMessage,
        },
        abort.signal,
        { language: routed.wireCode },
      );
      if (abort.signal.aborted) {
        transcriber.cancel();
        return;
      }
      transcriberRef.current = transcriber;
      for (const chunk of pendingChunks) transcriber.send(chunk);
      pendingChunks.length = 0;
      if (finishRequestedRef.current) void finish();
    } catch (error) {
      const aborted = abort.signal.aborted;
      cancel();
      if (!aborted) showMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    if (suspended || !provider) cancelRef.current();
  }, [provider, suspended]);
  useEffect(
    () => () => {
      cancelRef.current();
      if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
      if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
      if (doubleTapTimerRef.current) clearTimeout(doubleTapTimerRef.current);
    },
    [],
  );

  const clearDoubleTapTimer = (): void => {
    if (doubleTapTimerRef.current) clearTimeout(doubleTapTimerRef.current);
    doubleTapTimerRef.current = null;
  };
  const clearAwaitingSubmit = (): void => {
    awaitingSubmitRef.current = false;
    firstSubmitTapRef.current = 0;
    clearDoubleTapTimer();
  };
  const resetBurst = (): void => {
    if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
    burstTimerRef.current = null;
    pressCountRef.current = 0;
    typedSpacesRef.current = 0;
    if (phaseRef.current === "warmup" && !anchorRef.current) updatePhase("idle");
  };
  const armBurstTimer = (): void => {
    if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
    burstTimerRef.current = setTimeout(resetBurst, KEY_RELEASE_DEBOUNCE_MS);
  };
  // Remove up to `count` spaces immediately before the cursor, never digging
  // below `floor` remaining. Counting actual buffer spaces (not press
  // bookkeeping) lets the sweep absorb a stray space typed by the initial
  // press of an earlier burst — the key-repeat delay outlives the burst
  // debounce, so that press's counter is already gone.
  const stripTrailingSpacesAtCursor = (count: number, floor: number): void => {
    const buffer = bufferRef.current;
    const cursor = cursorRef.current;
    let spaces = 0;
    while (spaces < cursor && buffer[cursor - spaces - 1] === " ") spaces += 1;
    const strip = Math.max(0, Math.min(spaces - floor, count));
    if (strip > 0) {
      setBuffer(buffer.slice(0, cursor - strip) + buffer.slice(cursor));
      setCursor(cursor - strip);
    }
  };

  const handleKey = (input: string, key: Key, slashOpen: boolean): boolean => {
    if (key.escape && phaseRef.current !== "idle") {
      cancel();
      resetBurst();
      return true;
    }
    const plainSpace =
      !key.ctrl &&
      !key.meta &&
      !key.shift &&
      !key.tab &&
      !key.return &&
      input.length > 0 &&
      /^ +$/.test(input);
    if (!plainSpace || slashOpen || suspended || !provider) {
      if (!plainSpace) {
        if (awaitingSubmitRef.current) clearAwaitingSubmit();
        resetBurst();
      }
      return false;
    }
    const repeat = input.length;

    // Engaged hold: space repeats keep the recording alive and are swallowed.
    // A repeat proves the hold is still down, so it also cancels a deferred
    // finish requested by a debounce that fired while the event loop was
    // blocked (timers run before the queued stdin events on resume).
    if (anchorRef.current && (phaseRef.current === "warmup" || phaseRef.current === "recording")) {
      finishRequestedRef.current = false;
      armRelease(KEY_RELEASE_DEBOUNCE_MS);
      return true;
    }

    // Post-transcript double-tap submit (only with the cursor at the end).
    if (awaitingSubmitRef.current && phaseRef.current === "idle") {
      if (doubleTapTimerRef.current) {
        // A further press while a submit is deferred proves a hold, not a
        // tap: drop the pending submit and let the burst engage the hold.
        clearAwaitingSubmit();
      } else if (cursorRef.current !== bufferRef.current.length) {
        clearAwaitingSubmit();
      } else {
        const now = Date.now();
        if (
          firstSubmitTapRef.current > 0 &&
          now - firstSubmitTapRef.current <= DOUBLE_TAP_SUBMIT_MS
        ) {
          firstSubmitTapRef.current = 0;
          clearDoubleTapTimer();
          // Deferred so an immediately-following hold aborts the submit.
          doubleTapTimerRef.current = setTimeout(() => {
            doubleTapTimerRef.current = null;
            if (!awaitingSubmitRef.current || phaseRef.current !== "idle") return;
            awaitingSubmitRef.current = false;
            let text = bufferRef.current;
            if (text.endsWith(" ")) text = text.slice(0, -1);
            onSubmit(text);
            setBuffer("");
            setCursor(0);
          }, KEY_RELEASE_DEBOUNCE_MS);
          return true;
        }
        firstSubmitTapRef.current = now;
        // The first tap types a space and joins the burst below.
      }
    }

    const prevCount = pressCountRef.current;
    pressCountRef.current += repeat;
    armBurstTimer();

    if (phaseRef.current !== "recording" && pressCountRef.current >= HOLD_MIN_PRESSES) {
      if (phaseRef.current !== "idle" && !(phaseRef.current === "warmup" && !anchorRef.current)) {
        return true;
      }
      clearAwaitingSubmit();
      if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
      burstTimerRef.current = null;
      stripTrailingSpacesAtCursor(typedSpacesRef.current + repeat, 0);
      pressCountRef.current = 0;
      typedSpacesRef.current = 0;
      if (phaseRef.current === "warmup") updatePhase("idle");
      void begin();
      return true;
    }

    // Presses past the hint threshold are swallowed instead of typed; each
    // also sweeps one stray trailing space down to this burst's typed floor.
    if (prevCount >= HOLD_HINT_PRESSES) {
      stripTrailingSpacesAtCursor(repeat, typedSpacesRef.current);
      return true;
    }
    typedSpacesRef.current += repeat;
    if (phaseRef.current === "idle" && pressCountRef.current >= HOLD_HINT_PRESSES) {
      updatePhase("warmup");
    }
    return false;
  };

  const preview =
    anchorRef.current && transcript ? insertVoiceTranscript(anchorRef.current, transcript) : null;
  return { state: { phase, level, message, preview }, handleKey };
}
