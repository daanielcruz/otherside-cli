import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { getPlatform } from "@/kernel/std/proc/platform.ts";
import type { ImageMediaType } from "@/kernel/std/types/image.ts";

export const IMAGE_TARGET_RAW_SIZE = 3.75 * 1024 * 1024;
export const IMAGE_MAX_WIDTH = 2000;
export const IMAGE_MAX_HEIGHT = 2000;
export const MODEL_IMAGE_DIMENSION_OVERRIDES: Record<
  string,
  { maxWidth: number; maxHeight: number }
> = {
  "claude-opus-4-8": { maxWidth: 2576, maxHeight: 2576 },
};

export interface ResizedImage {
  buffer: Buffer;
  mediaType: ImageMediaType;
  dimensions?: {
    originalWidth: number;
    originalHeight: number;
    width: number;
    height: number;
  };
}

interface ResizeOptions {
  maxWidth?: number;
  maxHeight?: number;
  targetRawSize?: number;
}

export function resizeImageIfTooLarge(
  buffer: Buffer,
  mediaType: ImageMediaType,
  opts: ResizeOptions = {},
): ResizedImage {
  const maxW = opts.maxWidth ?? IMAGE_MAX_WIDTH;
  const maxH = opts.maxHeight ?? IMAGE_MAX_HEIGHT;
  const targetRaw = opts.targetRawSize ?? IMAGE_TARGET_RAW_SIZE;
  if (buffer.length === 0) {
    throw new Error("image buffer is empty");
  }
  const dims = readDimensions(buffer, mediaType);
  const overSize = buffer.length > targetRaw;
  const overDim = dims !== null && (dims.width > maxW || dims.height > maxH);
  if (!overSize && !overDim) {
    return { buffer, mediaType };
  }
  const scaleW = dims !== null && dims.width > maxW ? maxW / dims.width : 1;
  const scaleH = dims !== null && dims.height > maxH ? maxH / dims.height : 1;
  const targetScale = Math.min(scaleW, scaleH, 1);
  const targetWidth = dims !== null ? Math.max(1, Math.round(dims.width * targetScale)) : maxW;
  const targetHeight = dims !== null ? Math.max(1, Math.round(dims.height * targetScale)) : maxH;

  const onDarwin = getPlatform() === "macos";

  if (mediaType === "image/png") {
    let resizedBuffer: Buffer | null = null;
    if (onDarwin) {
      const dir = mkdtempSync(join(tmpdir(), "otherside-imgresize-"));
      const inPath = join(dir, "in.png");
      const outPath = join(dir, "out.png");
      try {
        writeFileSync(inPath, buffer);
        if (runSips(inPath, outPath, "png", targetWidth, targetHeight)) {
          resizedBuffer = readFileSync(outPath);
        }
      } finally {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
    if (!resizedBuffer) {
      resizedBuffer = resizePngPureJs(buffer, targetWidth, targetHeight);
    }
    return {
      buffer: resizedBuffer,
      mediaType: "image/png",
      dimensions: {
        originalWidth: dims?.width ?? maxW,
        originalHeight: dims?.height ?? maxH,
        width: targetWidth,
        height: targetHeight,
      },
    };
  }

  if (onDarwin) {
    const dir = mkdtempSync(join(tmpdir(), "otherside-imgresize-"));
    const ext = mediaType.split("/")[1] ?? "png";
    const inPath = join(dir, `in.${ext}`);
    const outPath = join(dir, `out.jpeg`);
    try {
      writeFileSync(inPath, buffer);
      if (runSips(inPath, outPath, "jpeg", targetWidth, targetHeight)) {
        let resized = readFileSync(outPath);
        let quality = 80;
        while (resized.length > targetRaw && quality > 30) {
          quality -= 10;
          runSipsQuality(outPath, outPath, quality);
          resized = readFileSync(outPath);
        }
        return {
          buffer: resized,
          mediaType: "image/jpeg",
          dimensions: {
            originalWidth: dims?.width ?? maxW,
            originalHeight: dims?.height ?? maxH,
            width: targetWidth,
            height: targetHeight,
          },
        };
      }
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }

  return { buffer, mediaType };
}

const COMPRESS_SCALING_FACTORS = [1.0, 0.75, 0.5, 0.25] as const;
const COMPRESS_JPEG_MAX_DIM = 600;
const COMPRESS_JPEG_QUALITY = 50;
const COMPRESS_ULTRA_MAX_DIM = 400;
const COMPRESS_ULTRA_QUALITY = 20;

export class ImageCompressError extends Error {
  constructor(actualBytes: number, maxBytes: number) {
    super(
      `Unable to compress image (${Math.round(actualBytes / 1024)}KB) to fit within ${Math.round(maxBytes / 1024)}KB. Please use a smaller image.`,
    );
    this.name = "ImageCompressError";
  }
}

// Shrinks an image below a hard byte budget through a progressively more
// aggressive ladder: (1) downscale at 100/75/50/25% preserving the original
// format, (2) moderate JPEG conversion at 600px, (3) last-resort JPEG at
// 400px/q20, returned even when it still misses the budget. Fails closed:
// when no encoder path produces output, it throws rather than letting an
// over-budget image through. Callers keep the dimensions from their own
// resize step; this pass reports none.
export function compressImageToBudget(
  buffer: Buffer,
  mediaType: ImageMediaType,
  maxBytes: number,
): ResizedImage {
  if (buffer.length <= maxBytes) return { buffer, mediaType };
  const dims = readDimensions(buffer, mediaType);

  if (getPlatform() === "macos") {
    const sameFormat: "png" | "jpeg" | null =
      mediaType === "image/png" ? "png" : mediaType === "image/jpeg" ? "jpeg" : null;
    if (sameFormat && dims !== null) {
      for (const scale of COMPRESS_SCALING_FACTORS) {
        const width = Math.max(1, Math.round(dims.width * scale));
        const height = Math.max(1, Math.round(dims.height * scale));
        const out = runSipsToBuffer(buffer, mediaType, sameFormat, width, height, 80);
        if (out !== null && out.length <= maxBytes) {
          return { buffer: out, mediaType: `image/${sameFormat}` as ImageMediaType };
        }
      }
    }
    const jpegW = Math.min(COMPRESS_JPEG_MAX_DIM, dims?.width ?? COMPRESS_JPEG_MAX_DIM);
    const jpegH = Math.min(COMPRESS_JPEG_MAX_DIM, dims?.height ?? COMPRESS_JPEG_MAX_DIM);
    const jpeg = runSipsToBuffer(buffer, mediaType, "jpeg", jpegW, jpegH, COMPRESS_JPEG_QUALITY);
    if (jpeg !== null && jpeg.length <= maxBytes) {
      return { buffer: jpeg, mediaType: "image/jpeg" };
    }
    const ultraW = Math.min(COMPRESS_ULTRA_MAX_DIM, dims?.width ?? COMPRESS_ULTRA_MAX_DIM);
    const ultraH = Math.min(COMPRESS_ULTRA_MAX_DIM, dims?.height ?? COMPRESS_ULTRA_MAX_DIM);
    const ultra = runSipsToBuffer(
      buffer,
      mediaType,
      "jpeg",
      ultraW,
      ultraH,
      COMPRESS_ULTRA_QUALITY,
    );
    if (ultra !== null) return { buffer: ultra, mediaType: "image/jpeg" };
    throw new ImageCompressError(buffer.length, maxBytes);
  }

  if (mediaType === "image/png" && dims !== null) {
    for (const scale of COMPRESS_SCALING_FACTORS) {
      if (scale === 1.0) continue; // pngjs re-encode at full size never shrinks
      const width = Math.max(1, Math.round(dims.width * scale));
      const height = Math.max(1, Math.round(dims.height * scale));
      const out = resizePngPureJs(buffer, width, height);
      if (out.length <= maxBytes) return { buffer: out, mediaType: "image/png" };
    }
  }

  throw new ImageCompressError(buffer.length, maxBytes);
}

function runSipsToBuffer(
  buffer: Buffer,
  inputMediaType: ImageMediaType,
  outFormat: "png" | "jpeg",
  width: number,
  height: number,
  quality: number,
): Buffer | null {
  const dir = mkdtempSync(join(tmpdir(), "otherside-imgbudget-"));
  const ext = inputMediaType.split("/")[1] ?? "png";
  const inPath = join(dir, `in.${ext}`);
  const outPath = join(dir, `out.${outFormat}`);
  try {
    writeFileSync(inPath, buffer);
    if (!runSips(inPath, outPath, outFormat, width, height)) return null;
    if (outFormat === "jpeg") runSipsQuality(outPath, outPath, quality);
    return readFileSync(outPath);
  } catch {
    return null;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

function resizePngPureJs(buffer: Buffer, targetWidth: number, targetHeight: number): Buffer {
  const png = PNG.sync.read(buffer);
  const dst = new PNG({ width: targetWidth, height: targetHeight });
  const srcW = png.width;
  const srcH = png.height;
  const srcData = png.data;
  const dstData = dst.data;
  for (let y = 0; y < targetHeight; y++) {
    const yNearest = Math.min(srcH - 1, Math.floor((y * srcH) / targetHeight));
    for (let x = 0; x < targetWidth; x++) {
      const xNearest = Math.min(srcW - 1, Math.floor((x * srcW) / targetWidth));
      const srcIdx = (yNearest * srcW + xNearest) * 4;
      const dstIdx = (y * targetWidth + x) * 4;
      dstData[dstIdx] = srcData[srcIdx]!;
      dstData[dstIdx + 1] = srcData[srcIdx + 1]!;
      dstData[dstIdx + 2] = srcData[srcIdx + 2]!;
      dstData[dstIdx + 3] = srcData[srcIdx + 3]!;
    }
  }
  return PNG.sync.write(dst);
}

function runSips(
  input: string,
  output: string,
  format: "png" | "jpeg",
  w: number,
  h: number,
): boolean {
  const r = spawnSync(
    "sips",
    [
      "-s",
      "format",
      format,
      "--resampleHeightWidthMax",
      String(Math.max(w, h)),
      input,
      "--out",
      output,
    ],
    { stdio: "ignore" },
  );
  return r.status === 0;
}

function runSipsQuality(input: string, output: string, q: number): boolean {
  const r = spawnSync("sips", ["-s", "formatOptions", String(q), input, "--out", output], {
    stdio: "ignore",
  });
  return r.status === 0;
}

function readDimensions(
  buf: Buffer,
  mediaType: ImageMediaType,
): { width: number; height: number } | null {
  if (mediaType === "image/png") return readPngDims(buf);
  if (mediaType === "image/jpeg") return readJpegDims(buf);
  if (mediaType === "image/gif") return readGifDims(buf);
  if (mediaType === "image/webp") return readWebpDims(buf);
  return null;
}

function readPngDims(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47 ||
    buf[12] !== 0x49 ||
    buf[13] !== 0x48 ||
    buf[14] !== 0x44 ||
    buf[15] !== 0x52
  )
    return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readJpegDims(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    i += 2;
    if (marker === undefined) return null;
    if (marker === 0xd8 || marker === 0xd9) {
      i += 0;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    const len = buf.readUInt16BE(i);
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      const height = buf.readUInt16BE(i + 3);
      const width = buf.readUInt16BE(i + 5);
      return { width, height };
    }
    i += len;
  }
  return null;
}

function readGifDims(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 10) return null;
  const sig = buf.subarray(0, 6).toString("ascii");
  if (sig !== "GIF87a" && sig !== "GIF89a") return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function readWebpDims(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 30) return null;
  if (buf.subarray(0, 4).toString("ascii") !== "RIFF") return null;
  if (buf.subarray(8, 12).toString("ascii") !== "WEBP") return null;
  const fourCc = buf.subarray(12, 16).toString("ascii");
  if (fourCc === "VP8 ") {
    if (buf.length < 30) return null;
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  if (fourCc === "VP8L") {
    if (buf.length < 25) return null;
    const b0 = buf[21];
    const b1 = buf[22];
    const b2 = buf[23];
    const b3 = buf[24];
    if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) return null;
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width, height };
  }
  if (fourCc === "VP8X") {
    if (buf.length < 30) return null;
    const b24 = buf[24];
    const b25 = buf[25];
    const b26 = buf[26];
    const b27 = buf[27];
    const b28 = buf[28];
    const b29 = buf[29];
    if (
      b24 === undefined ||
      b25 === undefined ||
      b26 === undefined ||
      b27 === undefined ||
      b28 === undefined ||
      b29 === undefined
    )
      return null;
    return {
      width: 1 + ((b26 << 16) | (b25 << 8) | b24),
      height: 1 + ((b29 << 16) | (b28 << 8) | b27),
    };
  }
  return null;
}
