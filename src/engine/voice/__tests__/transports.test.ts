import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import * as realHttp2Module from "node:http2";
import * as realWeriftModule from "werift";
import * as realWsModule from "ws";
import * as realAnthropicAuthModule from "@/engine/providers/anthropic/auth.ts";
import * as realAntigravityAuthModule from "@/engine/providers/antigravity/auth.ts";
import { userAgent as antigravityUserAgent } from "@/engine/providers/antigravity/fingerprint.ts";
import {
  activityEndMessage,
  activityStartMessage,
  audioMessage,
  grpcFrame,
  setupMessage,
} from "@/engine/providers/antigravity/voice-protobuf.ts";
import * as realCodexAuthModule from "@/engine/providers/codex/auth.ts";
import { userAgent as codexUserAgent } from "@/engine/providers/codex/fingerprint.ts";
import * as realXaiAuthModule from "@/engine/providers/xai/auth.ts";
import { userAgent as xaiUserAgent } from "@/engine/providers/xai/fingerprint.ts";

const realAnthropicAuth = { ...realAnthropicAuthModule };
const realAntigravityAuth = { ...realAntigravityAuthModule };
const realCodexAuth = { ...realCodexAuthModule };
const realXaiAuth = { ...realXaiAuthModule };

const originalFetch = global.fetch;
const anthropicPlatform =
  process.platform === "darwin"
    ? "macos"
    : process.platform === "win32"
      ? "windows"
      : process.platform;
let autoOpenSockets = true;
const sockets: FakeWebSocket[] = [];
const socketWaiters: Array<(socket: FakeWebSocket) => void> = [];
const peers: FakePeer[] = [];
const http2Clients: FakeHttp2Client[] = [];
const http2Waiters: Array<(client: FakeHttp2Client) => void> = [];

class FakeWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readonly headers: Record<string, string>;
  readonly sent: Array<string | Buffer> = [];
  readyState = FakeWebSocket.CONNECTING;
  closeCalls = 0;

  constructor(url: string | URL, options?: { headers?: Record<string, string> }) {
    super();
    this.url = String(url);
    this.headers = options?.headers ?? {};
    sockets.push(this);
    socketWaiters.shift()?.(this);
    if (autoOpenSockets) {
      queueMicrotask(() => {
        if (this.readyState !== FakeWebSocket.CONNECTING) return;
        this.readyState = FakeWebSocket.OPEN;
        this.emit("open");
      });
    }
  }

  send(data: string | Buffer): void {
    this.sent.push(typeof data === "string" ? data : Buffer.from(data));
  }

  close(): void {
    this.closeCalls += 1;
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }
}

class FakePeer {
  readonly transceivers: Array<{ kind: string; options: unknown }> = [];
  readonly dataChannels: string[] = [];
  localDescription: { type: string; sdp: string } | undefined;
  remoteDescription: { type: string; sdp: string } | undefined;
  closeCalls = 0;

  constructor() {
    peers.push(this);
  }

  addTransceiver(kind: string, options: unknown): void {
    this.transceivers.push({ kind, options });
  }

  createDataChannel(label: string): void {
    this.dataChannels.push(label);
  }

  async createOffer(): Promise<{ type: "offer"; sdp: string }> {
    return { type: "offer", sdp: "fake-local-offer-sdp" };
  }

  async setLocalDescription(description: { type: string; sdp: string }): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(description: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = description;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class FakeHttp2Stream extends EventEmitter {
  readonly writes: Buffer[] = [];
  ended = false;
  closed = false;

  write(chunk: Buffer): boolean {
    this.writes.push(Buffer.from(chunk));
    return true;
  }

  end(): void {
    this.ended = true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

class FakeHttp2Client extends EventEmitter {
  readonly stream = new FakeHttp2Stream();
  closed = false;
  requestHeaders: Record<string, string> | undefined;

  constructor(readonly origin: string) {
    super();
    http2Clients.push(this);
    http2Waiters.shift()?.(this);
  }

  request(headers: Record<string, string>): FakeHttp2Stream {
    this.requestHeaders = headers;
    return this.stream;
  }

  close(): void {
    this.closed = true;
  }
}

const fakeHttp2 = {
  connect(origin: string): FakeHttp2Client {
    return new FakeHttp2Client(origin);
  },
};

mock.module("ws", () => ({ WebSocket: FakeWebSocket, default: FakeWebSocket }));
mock.module("werift", () => ({ RTCPeerConnection: FakePeer }));
mock.module("node:http2", () => ({ ...fakeHttp2, default: fakeHttp2 }));
mock.module("@/engine/providers/anthropic/auth.ts", () => ({
  ...realAnthropicAuth,
  authorizationHeader: async () => "Bearer anthropic-access",
}));
mock.module("@/engine/providers/xai/auth.ts", () => ({
  ...realXaiAuth,
  currentTokens: async () => ({
    accessToken: "xai-access",
    refreshToken: "xai-refresh",
    expiresAt: 4_000_000_000_000,
  }),
}));
mock.module("@/engine/providers/codex/auth.ts", () => ({
  ...realCodexAuth,
  currentTokens: async () => ({
    accessToken: "codex-access",
    refreshToken: "codex-refresh",
    accountId: "account-123",
    expiresAt: 4_000_000_000_000,
  }),
}));
mock.module("@/engine/providers/antigravity/auth.ts", () => ({
  ...realAntigravityAuth,
  currentTokens: async () => ({
    accessToken: "google-access",
    refreshToken: "google-refresh",
    expiresAt: 4_000_000_000_000,
  }),
  resolveProjectId: async () => "project-123",
}));

import { connectVoice as connectAnthropicVoice } from "@/engine/providers/anthropic/voice.ts";
import { connectVoice as connectAntigravityVoice } from "@/engine/providers/antigravity/voice.ts";
import { connectVoice as connectCodexVoice } from "@/engine/providers/codex/voice.ts";
import { connectVoice as connectXaiVoice } from "@/engine/providers/xai/voice.ts";

function callbacks(): {
  callbacks: {
    onInterim: (text: string) => void;
    onFinal: (text: string) => void;
    onError: (message: string) => void;
  };
  interim: string[];
  final: string[];
  errors: string[];
} {
  const interim: string[] = [];
  const final: string[] = [];
  const errors: string[] = [];
  return {
    callbacks: {
      onInterim: (text) => interim.push(text),
      onFinal: (text) => final.push(text),
      onError: (message) => errors.push(message),
    },
    interim,
    final,
    errors,
  };
}

function waitForSocket(): Promise<FakeWebSocket> {
  const current = sockets.at(-1);
  if (current) return Promise.resolve(current);
  return new Promise((resolve) => socketWaiters.push(resolve));
}

function waitForHttp2Client(): Promise<FakeHttp2Client> {
  const current = http2Clients.at(-1);
  if (current) return Promise.resolve(current);
  return new Promise((resolve) => http2Waiters.push(resolve));
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function bytesField(field: number, value: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 2), varint(value.length), value]);
}

function finalTranscriptMessage(text: string): Buffer {
  const transcript = Buffer.concat([bytesField(1, Buffer.from(text)), Buffer.from([0x10, 0x01])]);
  return bytesField(2, bytesField(6, transcript));
}

function resetFakes(): void {
  for (const socket of sockets) socket.close();
  for (const peer of peers) void peer.close();
  for (const client of http2Clients) {
    client.stream.close();
    client.close();
  }
  sockets.length = 0;
  socketWaiters.length = 0;
  peers.length = 0;
  http2Clients.length = 0;
  http2Waiters.length = 0;
  autoOpenSockets = true;
}

describe("voice provider transports", () => {
  beforeEach(() => {
    global.fetch = originalFetch;
    resetFakes();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    resetFakes();
  });

  afterAll(() => {
    global.fetch = originalFetch;
    resetFakes();
    mock.module("ws", () => realWsModule);
    mock.module("werift", () => realWeriftModule);
    mock.module("node:http2", () => realHttp2Module);
    mock.module("@/engine/providers/anthropic/auth.ts", () => realAnthropicAuth);
    mock.module("@/engine/providers/xai/auth.ts", () => realXaiAuth);
    mock.module("@/engine/providers/codex/auth.ts", () => realCodexAuth);
    mock.module("@/engine/providers/antigravity/auth.ts", () => realAntigravityAuth);
  });

  it("covers the Anthropic WebSocket contract", async () => {
    const observed = callbacks();
    const transcriber = await connectAnthropicVoice(observed.callbacks, undefined, {
      language: "fr",
    });
    const socket = sockets.at(-1);
    if (!socket) throw new Error("expected Anthropic socket");

    expect(socket.url).toBe(
      "wss://api.anthropic.com/api/ws/speech_to_text/voice_stream?encoding=linear16&sample_rate=16000&channels=1&endpointing_ms=300&utterance_end_ms=1000&language=fr&use_conversation_engine=true&stt_provider=deepgram-nova3",
    );
    expect(socket.headers).toEqual({
      Authorization: "Bearer anthropic-access",
      "User-Agent": "claude-cli/2.1.211 (external, cli)",
      "x-app": "cli",
      "anthropic-client-platform": anthropicPlatform,
    });
    expect(transcriber.sampleRate).toBe(16_000);

    const pcm = Buffer.from([1, 2, 3, 4]);
    transcriber.send(pcm);
    expect(socket.sent).toEqual(['{"type":"KeepAlive"}', pcm]);

    const finish = transcriber.finish();
    const latePcm = Buffer.from([5, 6]);
    transcriber.send(latePcm);
    await Bun.sleep(5);
    expect(socket.sent).toEqual(['{"type":"KeepAlive"}', pcm, latePcm, '{"type":"CloseStream"}']);
    transcriber.send(Buffer.from([7, 8]));
    expect(socket.sent).toHaveLength(4);
    socket.emit("message", JSON.stringify({ type: "TranscriptText", data: "hello there" }));
    socket.emit("message", JSON.stringify({ type: "TranscriptEndpoint" }));

    await expect(finish).resolves.toBe("hello there");
    expect(observed.final).toEqual(["hello there"]);
    expect(socket.closeCalls).toBe(1);
  });

  it("waits for xAI transcript.created and completes audio.done", async () => {
    const observed = callbacks();
    let connected = false;
    const connection = connectXaiVoice(observed.callbacks, undefined, { language: "vi" }).then(
      (value) => {
        connected = true;
        return value;
      },
    );
    const socket = await waitForSocket();
    await Promise.resolve();
    expect(connected).toBe(false);
    socket.emit("message", JSON.stringify({ type: "transcript.created" }));
    const transcriber = await connection;

    expect(socket.url).toBe(
      "wss://api.x.ai/v1/stt?sample_rate=16000&encoding=pcm&interim_results=true&language=vi&endpointing=400",
    );
    expect(socket.headers).toEqual({
      Authorization: "Bearer xai-access",
      "x-grok-client-identifier": "grok-shell",
      "User-Agent": xaiUserAgent(),
    });

    const pcm = Buffer.from([5, 6, 7]);
    transcriber.send(pcm);
    const finish = transcriber.finish();
    const latePcm = Buffer.from([8, 9]);
    transcriber.send(latePcm);
    await Bun.sleep(5);
    expect(socket.sent).toEqual([pcm, latePcm, '{"type":"audio.done"}']);
    transcriber.send(Buffer.from([10, 11]));
    expect(socket.sent).toHaveLength(3);
    socket.emit("message", JSON.stringify({ type: "transcript.done", text: "xai transcript" }));

    await expect(finish).resolves.toBe("xai transcript");
    expect(observed.final).toEqual(["xai transcript"]);
    expect(socket.closeCalls).toBe(1);
  });

  it("accumulates xAI utterances across speech pauses", async () => {
    const observed = callbacks();
    const connection = connectXaiVoice(observed.callbacks);
    const socket = await waitForSocket();
    socket.emit("message", JSON.stringify({ type: "transcript.created" }));
    const transcriber = await connection;

    // First utterance: plain partial preview, then the speech_final commit.
    socket.emit("message", JSON.stringify({ type: "transcript.partial", text: "first" }));
    socket.emit(
      "message",
      JSON.stringify({ type: "transcript.partial", text: "first phrase", speech_final: true }),
    );
    // Pause; second utterance restarts partial text from scratch.
    socket.emit("message", JSON.stringify({ type: "transcript.partial", text: "second" }));
    expect(observed.interim).toEqual(["first", "first phrase second"]);
    // Chunk-final delta locks into the preview prefix without committing.
    socket.emit(
      "message",
      JSON.stringify({ type: "transcript.partial", text: "second thought", is_final: true }),
    );
    socket.emit("message", JSON.stringify({ type: "transcript.partial", text: "here" }));
    expect(observed.interim).toEqual([
      "first",
      "first phrase second",
      "first phrase second thought",
      "first phrase second thought here",
    ]);

    const finish = transcriber.finish();
    socket.emit(
      "message",
      JSON.stringify({ type: "transcript.done", text: "second thought here" }),
    );
    await expect(finish).resolves.toBe("first phrase second thought here");
    expect(observed.final).toEqual(["first phrase", "first phrase second thought here"]);
  });

  it("posts buffered 24kHz PCM to ChatGPT Desktop /transcribe multipart", async () => {
    const observed = callbacks();
    const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    global.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            text: "codex transcript",
            asset_pointer: "sediment://file_test",
            asset_ttl: "30d",
            asset_format: "webm",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as unknown as typeof fetch;

    const transcriber = await connectCodexVoice(observed.callbacks);
    expect(transcriber.sampleRate).toBe(24_000);
    expect(fetchCalls).toHaveLength(0);

    const pcm = Buffer.from([8, 9, 10, 11]);
    transcriber.send(pcm.subarray(0, 2));
    transcriber.send(pcm.subarray(2));
    const text = await transcriber.finish();
    expect(text).toBe("codex transcript");
    expect(observed.final).toEqual(["codex transcript"]);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://chatgpt.com/backend-api/transcribe");
    const headers = fetchCalls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer codex-access");
    expect(headers["chatgpt-account-id"]).toBe("account-123");
    expect(headers.originator).toBe("Codex Desktop");
    expect(headers["User-Agent"]).toBe(codexUserAgent());
    expect(headers.Accept).toBe("*/*");
    expect(headers["Content-Type"]).toMatch(
      /^multipart\/form-data; boundary=----codex-transcribe-[0-9a-f-]{36}$/,
    );
    const rawBody = fetchCalls[0]?.init?.body as ArrayBufferView | ArrayBuffer;
    const bodyBytes =
      rawBody instanceof ArrayBuffer
        ? new Uint8Array(rawBody)
        : new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
    const bodyText = Buffer.from(bodyBytes).toString("latin1");
    expect(bodyText).toContain('name="file"');
    expect(bodyText).toMatch(/filename="codex\.(webm|wav)"/);
    expect(bodyText).toMatch(/Content-Type: audio\/(webm;codecs=opus|wav)/);
    // late send after finish is ignored
    transcriber.send(Buffer.from([12, 13]));
    expect(fetchCalls).toHaveLength(1);
  });

  it("cancels Codex dictation without posting audio", async () => {
    const observed = callbacks();
    let fetchCount = 0;
    global.fetch = mock(() => {
      fetchCount += 1;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    const transcriber = await connectCodexVoice(observed.callbacks, undefined, { language: "pt" });
    transcriber.send(Buffer.from([1, 2, 3, 4]));
    transcriber.cancel();
    await expect(transcriber.finish()).resolves.toBe("");
    expect(fetchCount).toBe(0);
    expect(observed.final).toEqual([]);
  });

  it("defaults Anthropic and Grok language query params to en when unset or auto", async () => {
    await connectAnthropicVoice(callbacks().callbacks);
    expect(sockets.at(-1)?.url).toContain("language=en");
    resetFakes();

    await connectAnthropicVoice(callbacks().callbacks, undefined, { language: "auto" });
    expect(sockets.at(-1)?.url).toContain("language=en");
    expect(sockets.at(-1)?.url).not.toContain("language=auto");
    resetFakes();

    const autoConnection = connectXaiVoice(callbacks().callbacks, undefined, { language: "auto" });
    const autoSocket = await waitForSocket();
    autoSocket.emit("message", JSON.stringify({ type: "transcript.created" }));
    await autoConnection;
    expect(autoSocket.url).toContain("language=en");
    expect(autoSocket.url).not.toContain("language=auto");
    resetFakes();

    const connection = connectXaiVoice(callbacks().callbacks);
    const socket = await waitForSocket();
    socket.emit("message", JSON.stringify({ type: "transcript.created" }));
    await connection;
    expect(socket.url).toContain("language=en");
  });

  it("discovers the Gemini model and drives framed HTTP/2 voice activity", async () => {
    const observed = callbacks();
    const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    global.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return Promise.resolve(
        new Response(JSON.stringify({ audioTranscriptionModelIds: ["gemini-audio-test"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    const connection = connectAntigravityVoice(observed.callbacks);
    const client = await waitForHttp2Client();
    const stream = client.stream;
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    );
    expect(fetchCalls[0]?.init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer google-access",
        "User-Agent": antigravityUserAgent(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ project: "project-123" }),
    });
    expect(client.origin).toBe("https://aicode.googleapis.com");
    expect(client.requestHeaders).toEqual({
      ":method": "POST",
      ":path": "/google.gca.aicode.v1alpha.PredictionService/BidiGenerateContent",
      "content-type": "application/grpc",
      te: "trailers",
      authorization: "Bearer google-access",
      "user-agent": antigravityUserAgent(),
    });
    expect(stream.writes).toEqual([grpcFrame(setupMessage("gemini-audio-test"))]);

    stream.emit("data", grpcFrame(Buffer.from([0x0a, 0x00])));
    const transcriber = await connection;
    expect(stream.writes).toEqual([
      grpcFrame(setupMessage("gemini-audio-test")),
      grpcFrame(activityStartMessage()),
    ]);

    const pcm = Buffer.from([10, 11, 12]);
    transcriber.send(pcm);
    expect(stream.writes[2]).toEqual(grpcFrame(audioMessage(pcm)));

    const finish = transcriber.finish();
    const latePcm = Buffer.from([13, 14]);
    transcriber.send(latePcm);
    await Bun.sleep(5);
    expect(stream.writes[3]).toEqual(grpcFrame(audioMessage(latePcm)));
    expect(stream.writes[4]).toEqual(grpcFrame(activityEndMessage()));
    expect(stream.ended).toBe(true);
    transcriber.send(Buffer.from([15, 16]));
    expect(stream.writes).toHaveLength(5);
    stream.emit("data", grpcFrame(finalTranscriptMessage("gemini transcript")));

    await expect(finish).resolves.toBe("gemini transcript");
    expect(observed.final).toEqual(["gemini transcript"]);
    expect(stream.closed).toBe(true);
    expect(client.closed).toBe(true);
  });

  it("surfaces setup aborts and closes the Anthropic transport", async () => {
    autoOpenSockets = false;
    const controller = new AbortController();
    const connection = connectAnthropicVoice(callbacks().callbacks, controller.signal);
    const socket = await waitForSocket();
    controller.abort();

    await expect(connection).rejects.toThrow("voice transcription aborted");
    expect(socket.closeCalls).toBe(1);
  });
});
