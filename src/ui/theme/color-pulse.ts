import { isWebTerminalEngine } from "@/terminal-runtime/terminal/capability-policy.js";
import { rendersTruecolor } from "@/terminal-runtime/text/color-codes.js";
import type { HexColor, TerminalColor } from "@/terminal-runtime/text/style-model.js";

/** Frames in one cycle, at the interval that makes the cycle four seconds long. */
const PULSE_FRAMES = 20;
export const PULSE_FRAME_MS = 200;
/** How far the dim point of the cycle mixes the colour toward black. */
const PULSE_DEPTH = 0.18;
const HEX_COLOR = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

const palettes = new Map<string, readonly HexColor[] | null>();

/**
 * The colour `base` shows `atMs` into its pulse — a sinusoidal dip toward black and
 * back. Returns `base` unchanged whenever the terminal cannot render the steps apart.
 */
export function pulsedColor(base: TerminalColor, atMs: number): TerminalColor {
  // Below truecolor the frames quantize onto one cell, so the cycle is skipped.
  if (!rendersTruecolor()) return base;
  const palette = palettes.get(base) ?? cachePalette(base);
  if (palette === null) return base;
  const frame = Math.floor(Math.max(0, atMs) / PULSE_FRAME_MS) % PULSE_FRAMES;
  return palette[frame] ?? base;
}

function cachePalette(base: string): readonly HexColor[] | null {
  const palette = buildPalette(base);
  palettes.set(base, palette);
  return palette;
}

function buildPalette(base: string): readonly HexColor[] | null {
  const match = HEX_COLOR.exec(base.trim());
  if (match === null) return null;
  const channels = [match[1], match[2], match[3]].map((part) => Number.parseInt(part ?? "", 16));
  // Web terminal engines redraw the mid-cycle frames unevenly, so the curve is
  // squared there to keep the brightest frame off the visual midpoint.
  const eased = isWebTerminalEngine();
  return Array.from({ length: PULSE_FRAMES }, (_frame, index) => {
    const phase = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / PULSE_FRAMES);
    const kept = 1 - PULSE_DEPTH * (eased ? phase * phase : phase);
    return `#${channels.map((value) => channelHex(value * kept)).join("")}` as HexColor;
  });
}

function channelHex(value: number): string {
  return Math.round(value).toString(16).padStart(2, "0");
}

/** Grey endpoints and period of the breath that marks work with nothing to show yet. */
const BREATH_DIM_CHANNEL = 153;
const BREATH_BRIGHT_CHANNEL = 185;
const BREATH_PERIOD_MS = 2_000;
/** How often a breathing surface must repaint for the cycle to read as movement. */
export const BREATH_FRAME_MS = 50;

/**
 * The grey a breathing surface shows `atMs` into its cycle — a slow sweep between two
 * neutral tones, carrying no state of its own beyond "still working".
 */
export function breathingGrey(atMs: number): HexColor {
  const phase = (Math.sin((2 * Math.PI * Math.max(0, atMs)) / BREATH_PERIOD_MS) + 1) / 2;
  const channel = Math.round(
    BREATH_DIM_CHANNEL + (BREATH_BRIGHT_CHANNEL - BREATH_DIM_CHANNEL) * phase,
  );
  return `#${channelHex(channel).repeat(3)}` as HexColor;
}
