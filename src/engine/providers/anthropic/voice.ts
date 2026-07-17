import { WebSocket as WsClient } from "ws";
import { providerEndpoint } from "@/devtools/config.ts";
import type { VoiceTranscriber, VoiceTranscriberCallbacks } from "@/engine/voice/index.ts";
import { uaCli } from "./_infra/fingerprint.ts";
import { authorizationHeader } from "./auth.ts";

const VOICE_URL = providerEndpoint(
  "anthropic",
  "voice",
  "wss://api.anthropic.com/api/ws/speech_to_text/voice_stream",
);

function platformName(): string {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return process.platform;
}

export async function connectVoice(
  callbacks: VoiceTranscriberCallbacks,
  signal?: AbortSignal,
  options?: { language?: string | null },
): Promise<VoiceTranscriber> {
  // language is a query param on voice_stream (server rejects unknown codes with 1008).
  const requestedLanguage = options?.language?.trim();
  const language =
    !requestedLanguage || requestedLanguage.toLowerCase() === "auto" ? "en" : requestedLanguage;
  const params = new URLSearchParams({
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    endpointing_ms: "300",
    utterance_end_ms: "1000",
    language,
    use_conversation_engine: "true",
    stt_provider: "deepgram-nova3",
  });
  const ws = new WsClient(`${VOICE_URL}?${params}`, {
    headers: {
      Authorization: await authorizationHeader(),
      "User-Agent": uaCli(),
      "x-app": "cli",
      "anthropic-client-platform": platformName(),
    },
  });
  let finalText = "";
  let interimText = "";
  let settled = false;
  let connecting = true;
  let closed = false;
  let finalized = false;
  let resolveFinish: ((text: string) => void) | null = null;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  const closeTransport = (): void => {
    if (closed) return;
    closed = true;
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = null;
    if (ws.readyState !== WsClient.CLOSED) ws.close();
  };
  const settle = (): void => {
    if (settled) return;
    settled = true;
    if (finishTimer) clearTimeout(finishTimer);
    resolveFinish?.(finalText || interimText);
    closeTransport();
  };
  const sendKeepalive = (): void => {
    if (!settled && ws.readyState === WsClient.OPEN) ws.send('{"type":"KeepAlive"}');
  };

  ws.on("message", (data) => {
    if (typeof data !== "string" && !Buffer.isBuffer(data)) return;
    try {
      const message = JSON.parse(data.toString()) as {
        type?: string;
        data?: string;
        error_code?: string;
        description?: string;
        message?: string;
      };
      if (message.type === "TranscriptInterim" && typeof message.data === "string") {
        interimText = message.data;
        callbacks.onInterim(interimText);
      } else if (message.type === "TranscriptText" && typeof message.data === "string") {
        finalText = message.data;
        interimText = message.data;
        callbacks.onFinal(finalText);
      } else if (message.type === "TranscriptEndpoint") {
        settle();
      } else if (message.type === "TranscriptError" || message.type === "error") {
        callbacks.onError(
          message.description ||
            message.message ||
            message.error_code ||
            "voice transcription failed",
        );
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
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      ws.off("open", onOpen);
      ws.off("error", fail);
    };
    const fail = (error: Error): void => {
      cleanup();
      closeTransport();
      reject(error);
    };
    const onAbort = (): void => fail(new Error("voice transcription aborted"));
    const onOpen = (): void => {
      connecting = false;
      cleanup();
      sendKeepalive();
      keepaliveTimer = setInterval(sendKeepalive, 8_000);
      resolve();
    };
    timeout = setTimeout(() => fail(new Error("Anthropic voice connection timed out")), 10_000);
    signal?.addEventListener("abort", onAbort, { once: true });
    ws.once("open", onOpen);
    ws.once("error", fail);
  });

  const abort = (): void => {
    signal?.removeEventListener("abort", abort);
    settle();
  };
  signal?.addEventListener("abort", abort, { once: true });

  return {
    sampleRate: 16_000,
    send(chunk) {
      if (!settled && !finalized && ws.readyState === WsClient.OPEN) ws.send(Buffer.from(chunk));
    },
    finish() {
      if (settled) {
        signal?.removeEventListener("abort", abort);
        return Promise.resolve(finalText || interimText);
      }
      setTimeout(() => {
        finalized = true;
        if (!settled && ws.readyState === WsClient.OPEN) ws.send('{"type":"CloseStream"}');
      }, 0);
      return new Promise<string>((resolve) => {
        resolveFinish = resolve;
        finishTimer = setTimeout(settle, 1_500);
      }).finally(() => {
        signal?.removeEventListener("abort", abort);
        settle();
      });
    },
    cancel: abort,
  };
}
