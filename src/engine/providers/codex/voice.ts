import { randomUUID } from "node:crypto";
import { providerEndpoint } from "@/devtools/config.ts";
import type { VoiceTranscriber, VoiceTranscriberCallbacks } from "@/engine/voice/index.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import { currentTokens } from "./auth.ts";
import { authHeaderValue, ORIGINATOR_HTTP, userAgent } from "./fingerprint.ts";

const TRANSCRIBE_URL = providerEndpoint(
  "codex",
  "voice",
  "https://chatgpt.com/backend-api/transcribe",
);

const SAMPLE_RATE = 24_000;

function pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer {
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

async function encodeAudio(
  pcm: Buffer,
  sampleRate: number,
): Promise<{ bytes: Buffer; contentType: string; filename: string }> {
  // Live Desktop posts WebM/Opus (MediaRecorder). Prefer ffmpeg when available.
  try {
    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "s16le",
        "-ar",
        String(sampleRate),
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-c:a",
        "libopus",
        "-f",
        "webm",
        "pipe:1",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    proc.stdin.write(pcm);
    proc.stdin.end();
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      proc.exited,
    ]);
    if (code === 0 && stdout.byteLength > 0) {
      return {
        bytes: Buffer.from(stdout),
        contentType: "audio/webm;codecs=opus",
        filename: "codex.webm",
      };
    }
  } catch {
    // fall through to WAV
  }
  return {
    bytes: pcm16ToWav(pcm, sampleRate),
    contentType: "audio/wav",
    filename: "codex.wav",
  };
}

function buildMultipart(
  file: { bytes: Buffer; contentType: string; filename: string },
  boundary: string,
): Buffer {
  const head = Buffer.from(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${file.filename}"`,
      `Content-Type: ${file.contentType}`,
      "",
      "",
    ].join("\r\n"),
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return Buffer.concat([head, file.bytes, tail]);
}

export async function connectVoice(
  callbacks: VoiceTranscriberCallbacks,
  signal?: AbortSignal,
  _options?: { language?: string | null },
): Promise<VoiceTranscriber> {
  const tokens = await currentTokens();
  if (!tokens.accountId) throw new Error("Codex voice requires a ChatGPT account id");

  const chunks: Buffer[] = [];
  let closed = false;
  let finished = false;

  const cancel = (): void => {
    if (closed) return;
    closed = true;
    chunks.length = 0;
    signal?.removeEventListener("abort", cancel);
  };
  signal?.addEventListener("abort", cancel, { once: true });

  return {
    sampleRate: SAMPLE_RATE,
    send(chunk) {
      if (closed || finished) return;
      chunks.push(Buffer.from(chunk));
    },
    async finish() {
      if (closed) {
        signal?.removeEventListener("abort", cancel);
        return "";
      }
      if (finished) {
        signal?.removeEventListener("abort", cancel);
        return "";
      }
      finished = true;
      try {
        const pcm = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
        chunks.length = 0;
        if (pcm.length === 0) {
          callbacks.onFinal("");
          return "";
        }
        const encoded = await encodeAudio(pcm, SAMPLE_RATE);
        const boundary = `----codex-transcribe-${randomUUID()}`;
        const body = buildMultipart(encoded, boundary);
        const response = await fetch(TRANSCRIBE_URL, {
          method: "POST",
          headers: {
            Authorization: authHeaderValue(tokens.accessToken),
            "chatgpt-account-id": tokens.accountId!,
            originator: ORIGINATOR_HTTP,
            "User-Agent": userAgent(),
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            Accept: "*/*",
          },
          body,
          ...(signal ? { signal } : {}),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          const detail = text ? `: ${truncateEllipsis(text, 200)}` : "";
          const message = `Codex voice transcription failed with HTTP ${response.status}${detail}`;
          callbacks.onError(message);
          throw new Error(message);
        }
        const json = (await response.json()) as { text?: string };
        const text = typeof json.text === "string" ? json.text : "";
        if (text) callbacks.onFinal(text);
        return text;
      } finally {
        signal?.removeEventListener("abort", cancel);
        closed = true;
      }
    },
    cancel,
  };
}
