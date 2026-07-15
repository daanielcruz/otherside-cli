import { PNG } from "pngjs";

export type RgbColor = [number, number, number];

export type AutoKeyMode = "none" | "corners" | "border";

export interface ChromaKeyOptions {
  keyColor?: string;
  autoKey?: AutoKeyMode;
  tolerance?: number;
  softMatte?: boolean;
  transparentThreshold?: number;
  opaqueThreshold?: number;
  edgeFeather?: number;
  edgeContract?: number;
  spillCleanup?: boolean;
}

export interface ChromaKeyResult {
  png: Buffer;
  key: RgbColor;
  total: number;
  transparent: number;
  partial: number;
  warned: boolean;
}

const KEY_DOMINANCE_THRESHOLD = 16;
const ALPHA_NOISE_FLOOR = 8;

export function removeChromaKey(input: Buffer, options: ChromaKeyOptions = {}): ChromaKeyResult {
  const decoded = PNG.sync.read(input);
  const width = decoded.width;
  const height = decoded.height;
  const data = decoded.data;

  const tolerance = options.tolerance ?? 12;
  const softMatte = options.softMatte ?? false;
  const transparentThreshold = options.transparentThreshold ?? 12;
  const opaqueThreshold = options.opaqueThreshold ?? 96;
  const edgeFeather = options.edgeFeather ?? 0;
  const edgeContract = options.edgeContract ?? 0;
  const spillCleanup = options.spillCleanup ?? false;
  const autoKey = options.autoKey ?? "none";

  validate({
    tolerance,
    transparentThreshold,
    opaqueThreshold,
    edgeFeather,
    edgeContract,
    softMatte,
  });

  const key =
    autoKey !== "none"
      ? sampleBorderKey(data, width, height, autoKey)
      : parseKeyColor(options.keyColor ?? "#00ff00");

  let prematched = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const a = data[i + 3] ?? 0;
      const distance = channelDistance(r, g, b, key);
      const keyLike = looksKeyColored(r, g, b, key, distance);

      let outAlpha: number;
      if (softMatte && keyLike) {
        outAlpha = Math.min(
          softAlpha(distance, transparentThreshold, opaqueThreshold),
          dominanceAlpha(r, g, b, key),
        );
      } else {
        outAlpha = distance <= tolerance ? 0 : 255;
      }
      outAlpha = Math.round(outAlpha * (a / 255));
      if (outAlpha > 0 && outAlpha <= ALPHA_NOISE_FLOOR) outAlpha = 0;

      if (outAlpha === 0) {
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 0;
        prematched += 1;
        continue;
      }

      let outR = r;
      let outG = g;
      let outB = b;
      if (spillCleanup && keyLike) {
        const cleaned = cleanupSpill(r, g, b, key, outAlpha);
        outR = cleaned[0];
        outG = cleaned[1];
        outB = cleaned[2];
      }
      data[i] = outR;
      data[i + 1] = outG;
      data[i + 2] = outB;
      data[i + 3] = outAlpha;
    }
  }

  if (edgeContract > 0) contractAlpha(data, width, height, edgeContract);
  if (edgeFeather > 0) gaussianBlurAlpha(data, width, height, edgeFeather);

  const counts = alphaCounts(data);
  const out = new PNG({ width, height });
  data.copy(out.data);
  const png = PNG.sync.write(out);

  return {
    png,
    key,
    total: counts.total,
    transparent: counts.transparent,
    partial: counts.partial,
    warned: prematched === 0,
  };
}

interface ValidateInput {
  tolerance: number;
  transparentThreshold: number;
  opaqueThreshold: number;
  edgeFeather: number;
  edgeContract: number;
  softMatte: boolean;
}

function validate(opts: ValidateInput): void {
  if (opts.tolerance < 0 || opts.tolerance > 255) throw new Error("tolerance must be 0-255");
  if (opts.transparentThreshold < 0 || opts.transparentThreshold > 255)
    throw new Error("transparentThreshold must be 0-255");
  if (opts.opaqueThreshold < 0 || opts.opaqueThreshold > 255)
    throw new Error("opaqueThreshold must be 0-255");
  if (opts.softMatte && opts.transparentThreshold >= opts.opaqueThreshold)
    throw new Error("transparentThreshold must be lower than opaqueThreshold");
  if (opts.edgeFeather < 0 || opts.edgeFeather > 64) throw new Error("edgeFeather must be 0-64");
  if (opts.edgeContract < 0 || opts.edgeContract > 16) throw new Error("edgeContract must be 0-16");
}

export function parseKeyColor(raw: string): RgbColor {
  const value = raw.trim();
  const match = value.match(/^#?([0-9a-fA-F]{6})$/);
  if (!match) throw new Error("key color must be a hex RGB value like #00ff00");
  const hex = match[1] ?? "";
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function channelDistance(r: number, g: number, b: number, key: RgbColor): number {
  return Math.max(Math.abs(r - key[0]), Math.abs(g - key[1]), Math.abs(b - key[2]));
}

function clampChannel(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function smoothstep(x: number): number {
  const v = Math.max(0, Math.min(1, x));
  return v * v * (3 - 2 * v);
}

function softAlpha(distance: number, transparent: number, opaque: number): number {
  if (distance <= transparent) return 0;
  if (distance >= opaque) return 255;
  const ratio = (distance - transparent) / (opaque - transparent);
  return clampChannel(255 * smoothstep(ratio));
}

function spillChannels(key: RgbColor): number[] {
  const max = Math.max(key[0], key[1], key[2]);
  if (max < 128) return [];
  const result: number[] = [];
  for (let i = 0; i < 3; i++) {
    const v = key[i] ?? 0;
    if (v >= max - 16 && v >= 128) result.push(i);
  }
  return result;
}

function dominanceAlpha(r: number, g: number, b: number, key: RgbColor): number {
  const spill = spillChannels(key);
  if (spill.length === 0) return 255;
  const channels = [r, g, b];
  const nonSpill: number[] = [];
  for (let i = 0; i < 3; i++) if (!spill.includes(i)) nonSpill.push(i);
  const keyStrength =
    spill.length > 1
      ? Math.min(...spill.map((idx) => channels[idx] ?? 0))
      : (channels[spill[0] ?? 0] ?? 0);
  const nonKeyStrength =
    nonSpill.length === 0 ? 0 : Math.max(...nonSpill.map((idx) => channels[idx] ?? 0));
  const dominance = keyStrength - nonKeyStrength;
  if (dominance <= 0) return 255;
  const denom = Math.max(1, Math.max(key[0], key[1], key[2]) - nonKeyStrength);
  const alpha = 1 - Math.min(1, dominance / denom);
  return clampChannel(alpha * 255);
}

function keyChannelDominance(r: number, g: number, b: number, key: RgbColor): number {
  const spill = spillChannels(key);
  if (spill.length === 0) return 0;
  const channels = [r, g, b];
  const nonSpill: number[] = [];
  for (let i = 0; i < 3; i++) if (!spill.includes(i)) nonSpill.push(i);
  const keyStrength =
    spill.length > 1
      ? Math.min(...spill.map((idx) => channels[idx] ?? 0))
      : (channels[spill[0] ?? 0] ?? 0);
  const nonKeyStrength =
    nonSpill.length === 0 ? 0 : Math.max(...nonSpill.map((idx) => channels[idx] ?? 0));
  return keyStrength - nonKeyStrength;
}

function looksKeyColored(
  r: number,
  g: number,
  b: number,
  key: RgbColor,
  distance: number,
): boolean {
  if (distance <= 32) return true;
  const spill = spillChannels(key);
  if (spill.length === 0) return true;
  return keyChannelDominance(r, g, b, key) >= KEY_DOMINANCE_THRESHOLD;
}

function cleanupSpill(r: number, g: number, b: number, key: RgbColor, alpha: number): RgbColor {
  if (alpha >= 252) return [r, g, b];
  const spill = spillChannels(key);
  if (spill.length === 0) return [r, g, b];
  const channels = [r, g, b];
  const nonSpill: number[] = [];
  for (let i = 0; i < 3; i++) if (!spill.includes(i)) nonSpill.push(i);
  if (nonSpill.length > 0) {
    const anchor = Math.max(...nonSpill.map((idx) => channels[idx] ?? 0));
    const cap = Math.max(0, anchor - 1);
    for (const idx of spill) {
      const c = channels[idx] ?? 0;
      if (c > cap) channels[idx] = cap;
    }
  }
  return [
    clampChannel(channels[0] ?? 0),
    clampChannel(channels[1] ?? 0),
    clampChannel(channels[2] ?? 0),
  ];
}

function sampleBorderKey(data: Buffer, width: number, height: number, mode: AutoKeyMode): RgbColor {
  const samples: RgbColor[] = [];
  if (mode === "corners") {
    const patch = Math.max(1, Math.min(width, height, 12));
    const boxes: [number, number, number, number][] = [
      [0, 0, patch, patch],
      [width - patch, 0, width, patch],
      [0, height - patch, patch, height],
      [width - patch, height - patch, width, height],
    ];
    for (const [left, top, right, bottom] of boxes) {
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const i = (y * width + x) * 4;
          samples.push([data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0]);
        }
      }
    }
  } else {
    const band = Math.max(1, Math.min(width, height, 6));
    const step = Math.max(1, Math.floor(Math.min(width, height) / 256));
    for (let x = 0; x < width; x += step) {
      for (let y = 0; y < band; y++) {
        const top = (y * width + x) * 4;
        samples.push([data[top] ?? 0, data[top + 1] ?? 0, data[top + 2] ?? 0]);
        const bot = ((height - 1 - y) * width + x) * 4;
        samples.push([data[bot] ?? 0, data[bot + 1] ?? 0, data[bot + 2] ?? 0]);
      }
    }
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < band; x++) {
        const left = (y * width + x) * 4;
        samples.push([data[left] ?? 0, data[left + 1] ?? 0, data[left + 2] ?? 0]);
        const right = (y * width + (width - 1 - x)) * 4;
        samples.push([data[right] ?? 0, data[right + 1] ?? 0, data[right + 2] ?? 0]);
      }
    }
  }
  if (samples.length === 0) throw new Error("could not sample border key color");
  return [medianChannel(samples, 0), medianChannel(samples, 1), medianChannel(samples, 2)];
}

function medianChannel(samples: RgbColor[], idx: number): number {
  const values = samples.map((s) => s[idx] ?? 0).sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  if (values.length % 2 === 0) {
    return Math.round(((values[mid - 1] ?? 0) + (values[mid] ?? 0)) / 2);
  }
  return values[mid] ?? 0;
}

function contractAlpha(data: Buffer, width: number, height: number, pixels: number): void {
  for (let pass = 0; pass < pixels; pass++) {
    const next = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let m = 255;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ny = y + dy;
            const nx = x + dx;
            if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue;
            const v = data[(ny * width + nx) * 4 + 3] ?? 255;
            if (v < m) m = v;
          }
        }
        next[y * width + x] = m;
      }
    }
    for (let i = 0; i < width * height; i++) {
      data[i * 4 + 3] = next[i] ?? 0;
    }
  }
}

function gaussianBlurAlpha(data: Buffer, width: number, height: number, radius: number): void {
  const sigma = radius;
  const kernelRadius = Math.max(1, Math.ceil(radius * 2));
  const kernel: number[] = [];
  let sum = 0;
  for (let i = -kernelRadius; i <= kernelRadius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(v);
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] = (kernel[i] ?? 0) / sum;

  const horiz = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let i = -kernelRadius; i <= kernelRadius; i++) {
        const sx = Math.min(width - 1, Math.max(0, x + i));
        const a = data[(y * width + sx) * 4 + 3] ?? 0;
        acc += a * (kernel[i + kernelRadius] ?? 0);
      }
      horiz[y * width + x] = clampChannel(acc);
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let i = -kernelRadius; i <= kernelRadius; i++) {
        const sy = Math.min(height - 1, Math.max(0, y + i));
        const a = horiz[sy * width + x] ?? 0;
        acc += a * (kernel[i + kernelRadius] ?? 0);
      }
      data[(y * width + x) * 4 + 3] = clampChannel(acc);
    }
  }
}

function alphaCounts(data: Buffer): { total: number; transparent: number; partial: number } {
  const total = data.length / 4;
  let transparent = 0;
  let partial = 0;
  for (let i = 0; i < total; i++) {
    const a = data[i * 4 + 3] ?? 0;
    if (a === 0) transparent += 1;
    else if (a < 255) partial += 1;
  }
  return { total, transparent, partial };
}
