import { describe, expect, it } from "bun:test";
import { PNG } from "pngjs";
import { compressImageToBudget } from "../image-resize.ts";

function noisyPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i++) {
    png.data[i] = (i * 2654435761) % 251;
  }
  return PNG.sync.write(png);
}

describe("compressImageToBudget", () => {
  it("returns the buffer untouched when already within budget", () => {
    const small = noisyPng(20, 20);
    const out = compressImageToBudget(small, "image/png", 512_000);
    expect(out.buffer).toBe(small);
    expect(out.mediaType).toBe("image/png");
  });

  it("shrinks an over-budget image below the byte budget", () => {
    const big = noisyPng(1200, 1200);
    expect(big.length).toBeGreaterThan(512_000);
    const out = compressImageToBudget(big, "image/png", 512_000);
    expect(out.buffer.length).toBeLessThanOrEqual(512_000);
    expect(["image/png", "image/jpeg"]).toContain(out.mediaType);
  });
});
