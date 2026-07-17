import http2 from "node:http2";
import { providerEndpoint } from "@/devtools/config.ts";
import type { VoiceTranscriber, VoiceTranscriberCallbacks } from "@/engine/voice/index.ts";
import { currentTokens, resolveProjectId } from "./auth.ts";
import { backendHost, userAgent } from "./fingerprint.ts";
import {
  activityEndMessage,
  activityStartMessage,
  audioMessage,
  grpcFrame,
  parseServerMessage,
  readGrpcFrames,
  setupMessage,
} from "./voice-protobuf.ts";

const GRPC_ORIGIN = providerEndpoint("antigravity", "voice", "https://aicode.googleapis.com");
const GRPC_PATH = "/google.gca.aicode.v1alpha.PredictionService/BidiGenerateContent";

async function audioModel(
  accessToken: string,
  project: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`${backendHost()}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": userAgent(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ project }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 403 && /insufficient authentication scopes/i.test(body)) {
      throw new Error("Gemini voice needs additional Google authorization.");
    }
    const suffix =
      response.status === 401 || response.status === 403
        ? " — run `otherside login --provider antigravity` to grant voice access"
        : "";
    throw new Error(`Gemini voice model discovery failed with HTTP ${response.status}${suffix}`);
  }
  const payload = (await response.json()) as { audioTranscriptionModelIds?: unknown };
  const model = Array.isArray(payload.audioTranscriptionModelIds)
    ? payload.audioTranscriptionModelIds.find(
        (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
      )
    : undefined;
  if (!model) throw new Error("no Gemini voice transcription model is available for this account");
  return model;
}

export async function connectVoice(
  callbacks: VoiceTranscriberCallbacks,
  signal?: AbortSignal,
): Promise<VoiceTranscriber> {
  const tokens = await currentTokens();
  const project = await resolveProjectId(tokens);
  const model = await audioModel(tokens.accessToken, project, signal);
  const client = http2.connect(GRPC_ORIGIN);
  const stream = client.request({
    ":method": "POST",
    ":path": GRPC_PATH,
    "content-type": "application/grpc",
    te: "trailers",
    authorization: `Bearer ${tokens.accessToken}`,
    "user-agent": userAgent(),
  });
  let incoming: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let transcript = "";
  let settled = false;
  let connecting = true;
  let closed = false;
  let finalized = false;
  let resolveFinish: ((text: string) => void) | null = null;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: Error) => void) | null = null;

  const closeTransport = (): void => {
    if (closed) return;
    closed = true;
    if (!stream.closed) stream.close();
    if (!client.closed) client.close();
  };
  const settle = (): void => {
    if (settled) return;
    settled = true;
    if (finishTimer) clearTimeout(finishTimer);
    resolveFinish?.(transcript);
    closeTransport();
  };

  stream.on("data", (chunk: Buffer) => {
    incoming = Buffer.concat([incoming, chunk]);
    const parsed = readGrpcFrames(incoming);
    incoming = parsed.rest;
    for (const message of parsed.messages) {
      const event = parseServerMessage(message);
      if (event?.type === "ready") {
        stream.write(grpcFrame(activityStartMessage()));
        connecting = false;
        resolveReady?.();
      } else if (event?.type === "transcript") {
        transcript = event.text || transcript;
        if (event.final) {
          callbacks.onFinal(transcript);
          settle();
        } else {
          callbacks.onInterim(transcript);
        }
      }
    }
  });
  stream.on("trailers", (headers) => {
    const status = headers["grpc-status"];
    if (status !== undefined && status !== "0") {
      const error = new Error(
        String(headers["grpc-message"] ?? `Gemini voice gRPC status ${status}`),
      );
      if (connecting) rejectReady?.(error);
      else callbacks.onError(error.message);
      settle();
    }
  });
  stream.on("error", (error) => {
    if (connecting) rejectReady?.(error);
    else callbacks.onError(error.message);
    settle();
  });
  stream.on("close", settle);
  client.on("error", (error) => {
    if (connecting) rejectReady?.(error);
    else callbacks.onError(error.message);
    settle();
  });

  const cancel = (): void => {
    signal?.removeEventListener("abort", cancel);
    if (connecting) rejectReady?.(new Error("voice transcription aborted"));
    else settle();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  stream.write(grpcFrame(setupMessage(model)));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => rejectReady?.(new Error("Gemini voice setup timed out")),
      15_000,
    );
    resolveReady = () => {
      clearTimeout(timer);
      resolve();
    };
    rejectReady = (error) => {
      clearTimeout(timer);
      settle();
      reject(error);
    };
  });
  resolveReady = null;
  rejectReady = null;

  return {
    sampleRate: 16_000,
    send(chunk) {
      if (!settled && !finalized && !stream.closed) {
        stream.write(grpcFrame(audioMessage(Buffer.from(chunk))));
      }
    },
    finish() {
      if (settled) {
        signal?.removeEventListener("abort", cancel);
        return Promise.resolve(transcript);
      }
      setTimeout(() => {
        finalized = true;
        if (!settled && !stream.closed) {
          stream.write(grpcFrame(activityEndMessage()));
          stream.end();
        }
      }, 0);
      return new Promise<string>((resolve) => {
        resolveFinish = resolve;
        finishTimer = setTimeout(settle, 10_000);
      }).finally(() => {
        signal?.removeEventListener("abort", cancel);
        settle();
      });
    },
    cancel,
  };
}
