import { WebSocket as WsClient } from "ws";
import { providerEndpoint } from "@/devtools/config.ts";
import type { VoiceTranscriber, VoiceTranscriberCallbacks } from "@/engine/voice/index.ts";
import { currentTokens } from "./auth.ts";
import { GROK_CLIENT_IDENTIFIER, userAgent } from "./fingerprint.ts";

const VOICE_URL = providerEndpoint("xai", "voice", "wss://api.x.ai/v1/stt");

export async function connectVoice(
  callbacks: VoiceTranscriberCallbacks,
  signal?: AbortSignal,
  options?: { language?: string | null },
): Promise<VoiceTranscriber> {
  const tokens = await currentTokens();
  // language is a query param on the STT WebSocket; never send "auto".
  const requestedLanguage = options?.language?.trim();
  const language =
    !requestedLanguage || requestedLanguage.toLowerCase() === "auto" ? "en" : requestedLanguage;
  const params = new URLSearchParams({
    sample_rate: "16000",
    encoding: "pcm",
    interim_results: "true",
    language,
    endpointing: "400",
  });
  const ws = new WsClient(`${VOICE_URL}?${params}`, {
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
      "User-Agent": userAgent(),
    },
  });
  // Partial text is per-utterance and arrives in three grades: plain partials
  // preview the current chunk, chunk-finals (is_final without speech_final)
  // are ~3s deltas of the turn that stitch into a locked prefix so a long
  // pauseless utterance keeps accumulating on screen, and speech_final is a
  // clean one-pass re-transcription of the whole utterance — the only text
  // that commits. Committed utterances accumulate across pauses.
  let committed = "";
  let lockedChunks = "";
  let interim = "";
  let ready = false;
  let settled = false;
  let connecting = true;
  let closed = false;
  let finalized = false;
  let resolveFinish: ((text: string) => void) | null = null;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;

  const closeTransport = (): void => {
    if (closed) return;
    closed = true;
    if (ws.readyState !== WsClient.CLOSED) ws.close();
  };
  const joined = (tail: string): string => {
    const extra = tail.trim();
    if (!extra) return committed;
    return committed ? `${committed} ${extra}` : extra;
  };
  const settle = (): void => {
    if (settled) return;
    settled = true;
    if (finishTimer) clearTimeout(finishTimer);
    resolveFinish?.(joined(interim));
    closeTransport();
  };

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString()) as {
        type?: string;
        text?: string;
        is_final?: boolean;
        speech_final?: boolean;
        message?: string;
      };
      if (message.type === "transcript.created") ready = true;
      else if (message.type === "transcript.partial" && typeof message.text === "string") {
        const text = message.text.trim();
        if (!text) return;
        if (message.speech_final) {
          committed = joined(text);
          lockedChunks = "";
          interim = "";
          callbacks.onFinal(committed);
        } else if (message.is_final) {
          lockedChunks = lockedChunks ? `${lockedChunks} ${text}` : text;
          interim = lockedChunks;
          callbacks.onInterim(joined(interim));
        } else {
          interim = lockedChunks ? `${lockedChunks} ${text}` : text;
          callbacks.onInterim(joined(interim));
        }
      } else if (message.type === "transcript.done") {
        committed = joined(message.text ?? interim);
        lockedChunks = "";
        interim = "";
        if (committed) callbacks.onFinal(committed);
        settle();
      } else if (message.type === "error") {
        callbacks.onError(message.message || "Grok voice transcription failed");
        settle();
      }
    } catch {}
  });
  ws.on("error", (error) => {
    if (connecting) return;
    callbacks.onError(error.message);
    settle();
  });
  ws.on("close", settle);

  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = (): void => {
      clearTimeout(timeout);
      if (readyTimer) clearTimeout(readyTimer);
      signal?.removeEventListener("abort", onAbort);
      ws.off("open", checkReady);
      ws.off("error", fail);
    };
    const fail = (error: Error): void => {
      cleanup();
      closeTransport();
      reject(error);
    };
    const onAbort = (): void => fail(new Error("voice transcription aborted"));
    const checkReady = (): void => {
      if (ready) {
        connecting = false;
        cleanup();
        resolve();
      } else if (ws.readyState === WsClient.OPEN) {
        readyTimer = setTimeout(checkReady, 20);
      }
    };
    timeout = setTimeout(() => fail(new Error("Grok voice connection timed out")), 10_000);
    ws.once("open", checkReady);
    ws.once("error", fail);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  const cancel = (): void => {
    signal?.removeEventListener("abort", cancel);
    settle();
  };
  signal?.addEventListener("abort", cancel, { once: true });

  return {
    sampleRate: 16_000,
    send(chunk) {
      if (!settled && !finalized && ws.readyState === WsClient.OPEN) ws.send(Buffer.from(chunk));
    },
    finish() {
      if (settled) {
        signal?.removeEventListener("abort", cancel);
        return Promise.resolve(joined(interim));
      }
      setTimeout(() => {
        finalized = true;
        if (!settled && ws.readyState === WsClient.OPEN) ws.send('{"type":"audio.done"}');
      }, 0);
      return new Promise<string>((resolve) => {
        resolveFinish = resolve;
        finishTimer = setTimeout(settle, 5_000);
      }).finally(() => {
        signal?.removeEventListener("abort", cancel);
        settle();
      });
    },
    cancel,
  };
}
