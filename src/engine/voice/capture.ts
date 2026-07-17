import { spawn, spawnSync } from "node:child_process";
import { Pcm16Resampler } from "./pcm.ts";

interface NativeCapture {
  startCapture(
    onData: (error: Error | null, data: Buffer) => void,
    onError: (error: Error | null, message: string) => void,
  ): { sampleRate: number; channels: number };
  stopCapture(): void;
}

export interface AudioCapture {
  stop(): void;
}

function nativeAddon(): NativeCapture | null {
  try {
    return require("./native/audio-capture.node") as NativeCapture;
  } catch {
    return null;
  }
}

function hasCommand(command: string): boolean {
  return spawnSync(command, ["--version"], { stdio: "ignore", timeout: 2_000 }).error === undefined;
}

function levelOfPcm16(chunk: Buffer): number {
  if (chunk.length < 2) return 0;
  let energy = 0;
  const samples = Math.floor(chunk.length / 2);
  for (let offset = 0; offset + 1 < chunk.length; offset += 2) {
    const sample = chunk.readInt16LE(offset);
    energy += sample * sample;
  }
  // RMS in 16-bit sample units, normalized against 2000 with a sqrt curve
  // so quiet speech still spans the visualizer's full range.
  const rms = Math.sqrt(energy / samples);
  return Math.sqrt(Math.min(rms / 2000, 1));
}

function recorder(targetRate: number): { command: string; args: string[] } | null {
  if (process.platform === "linux") {
    if (hasCommand("pw-record")) {
      return {
        command: "pw-record",
        args: ["--rate", String(targetRate), "--channels", "1", "--format", "s16", "-"],
      };
    }
    if (hasCommand("parec")) {
      return {
        command: "parec",
        args: ["--raw", "--format=s16le", `--rate=${targetRate}`, "--channels=1"],
      };
    }
    if (hasCommand("arecord")) {
      return {
        command: "arecord",
        args: ["-q", "-t", "raw", "-f", "S16_LE", "-c", "1", "-r", String(targetRate), "-"],
      };
    }
  }
  if (process.platform !== "win32" && hasCommand("rec")) {
    return {
      command: "rec",
      args: [
        "-q",
        "--buffer",
        "1024",
        "-t",
        "raw",
        "-r",
        String(targetRate),
        "-e",
        "signed",
        "-b",
        "16",
        "-c",
        "1",
        "-",
      ],
    };
  }
  return null;
}

function startSubprocessCapture(
  targetRate: number,
  onData: (chunk: Buffer) => void,
  onLevel: (level: number) => void,
  onError: (message: string) => void,
): AudioCapture {
  const selected = recorder(targetRate);
  if (!selected) {
    throw new Error(
      process.platform === "win32"
        ? "native microphone capture is unavailable"
        : "microphone capture requires the native addon or SoX/arecord/PipeWire",
    );
  }
  const child = spawn(selected.command, selected.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (value: Buffer) => {
    const chunk = Buffer.from(value);
    onLevel(levelOfPcm16(chunk));
    onData(chunk);
  });
  let stderr = "";
  child.stderr.on("data", (value: Buffer) => {
    if (stderr.length < 500) stderr += value.toString();
  });
  child.on("error", (error) => onError(error.message));
  child.on("close", (code) => {
    if (code && code !== 143) onError(stderr.trim() || `microphone recorder exited with ${code}`);
  });
  return {
    stop() {
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}

export function startAudioCapture(
  targetRate: number,
  onData: (chunk: Buffer) => void,
  onLevel: (level: number) => void,
  onError: (message: string) => void,
): AudioCapture {
  const addon = nativeAddon();
  if (!addon) return startSubprocessCapture(targetRate, onData, onLevel, onError);
  let resampler: Pcm16Resampler | null = null;
  const info = addon.startCapture(
    (error, data) => {
      if (error) {
        onError(error.message);
        return;
      }
      const aligned =
        data.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0
          ? { buffer: data.buffer, byteOffset: data.byteOffset }
          : { buffer: Uint8Array.from(data).buffer, byteOffset: 0 };
      const floats = new Float32Array(
        aligned.buffer,
        aligned.byteOffset,
        Math.floor(data.byteLength / Float32Array.BYTES_PER_ELEMENT),
      );
      const encoded = resampler?.push(floats);
      if (!encoded) return;
      onLevel(encoded.level);
      if (encoded.pcm.length > 0) onData(encoded.pcm);
    },
    (error, message) => onError(error?.message || message),
  );
  try {
    resampler = new Pcm16Resampler(info.sampleRate, targetRate);
  } catch (error) {
    addon.stopCapture();
    throw error;
  }
  return {
    stop() {
      addon.stopCapture();
    },
  };
}
