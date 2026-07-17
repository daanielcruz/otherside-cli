import { describe, expect, it } from "bun:test";
import { Pcm16Resampler } from "@/engine/voice/pcm.ts";

describe("voice PCM conversion", () => {
  it("resamples float mono to signed PCM16", () => {
    const converter = new Pcm16Resampler(48_000, 16_000);
    const result = converter.push(new Float32Array(480).fill(0.5));
    expect(result.pcm.length / 2).toBeGreaterThanOrEqual(159);
    expect(result.pcm.readInt16LE(0)).toBe(16_384);
    expect(result.level).toBe(1);
  });

  it("spreads quiet speech across the visualizer range", () => {
    const converter = new Pcm16Resampler(16_000, 16_000);
    const quiet = converter.push(new Float32Array(160).fill(0.02));
    expect(quiet.level).toBeCloseTo(Math.sqrt(Math.min((0.02 * 32768) / 2000, 1)), 4);
    expect(quiet.level).toBeGreaterThan(0.15);
    const silent = converter.push(new Float32Array(160).fill(0.001));
    expect(silent.level).toBeLessThan(0.15);
  });

  it("preserves fractional state across chunks and clamps", () => {
    const converter = new Pcm16Resampler(44_100, 24_000);
    const first = converter.push(new Float32Array([2, 2, 2]));
    const second = converter.push(new Float32Array([2, 2, 2]));
    expect(first.pcm.length + second.pcm.length).toBeGreaterThan(0);
    const values = Buffer.concat([first.pcm, second.pcm]);
    for (let offset = 0; offset < values.length; offset += 2) {
      expect(values.readInt16LE(offset)).toBe(32_767);
    }
  });

  it("produces the same downsampled stream across short chunks", () => {
    const input = Float32Array.from({ length: 100 }, (_, index) => index / 100);
    const contiguous = new Pcm16Resampler(48_000, 16_000).push(input).pcm;
    const chunked = new Pcm16Resampler(48_000, 16_000);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < input.length; offset += 5) {
      chunks.push(chunked.push(input.slice(offset, offset + 5)).pcm);
    }
    expect(Buffer.concat(chunks).toString("hex")).toBe(contiguous.toString("hex"));
  });
});
