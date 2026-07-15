import type { Chord, KeybindingBlock, ParsedBinding, ParsedKeystroke } from "./types.js";

export function parseKeystroke(input: string): ParsedKeystroke {
  const parts = input.split("+");
  const keystroke: ParsedKeystroke = {
    key: "",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    super: false,
  };
  for (const part of parts) {
    const lower = part.toLowerCase();
    switch (lower) {
      case "ctrl":
      case "control":
        keystroke.ctrl = true;
        break;
      case "alt":
      case "opt":
      case "option":
        keystroke.alt = true;
        break;
      case "shift":
        keystroke.shift = true;
        break;
      case "meta":
        keystroke.meta = true;
        break;
      case "cmd":
      case "command":
      case "super":
      case "win":
        keystroke.super = true;
        break;
      case "esc":
        keystroke.key = "escape";
        break;
      case "return":
        keystroke.key = "enter";
        break;
      case "space":
        keystroke.key = " ";
        break;
      case "↑":
        keystroke.key = "up";
        break;
      case "↓":
        keystroke.key = "down";
        break;
      case "←":
        keystroke.key = "left";
        break;
      case "→":
        keystroke.key = "right";
        break;
      default:
        keystroke.key = lower;
        break;
    }
  }

  return keystroke;
}

export function parseChord(input: string): Chord {
  if (input === " ") return [parseKeystroke("space")];
  return input.trim().split(/\s+/).map(parseKeystroke);
}

export function keystrokeToString(ks: ParsedKeystroke): string {
  const parts: string[] = [];
  if (ks.ctrl) parts.push("ctrl");
  if (ks.alt) parts.push("alt");
  if (ks.shift) parts.push("shift");
  if (ks.meta) parts.push("meta");
  if (ks.super) parts.push("cmd");
  const displayKey = keyToDisplayName(ks.key);
  parts.push(displayKey);
  return parts.join("+");
}

function keyToDisplayName(key: string): string {
  switch (key) {
    case "escape":
      return "Esc";
    case " ":
      return "Space";
    case "tab":
      return "tab";
    case "enter":
      return "Enter";
    case "backspace":
      return "Backspace";
    case "delete":
      return "Delete";
    case "up":
      return "↑";
    case "down":
      return "↓";
    case "left":
      return "←";
    case "right":
      return "→";
    case "pageup":
      return "PageUp";
    case "pagedown":
      return "PageDown";
    case "home":
      return "Home";
    case "end":
      return "End";
    default:
      return key;
  }
}

export function chordToString(chord: Chord): string {
  return chord.map(keystrokeToString).join(" ");
}

type DisplayPlatform = "macos" | "windows" | "linux" | "wsl" | "unknown";

export function keystrokeToDisplayString(
  ks: ParsedKeystroke,
  platform: DisplayPlatform = "linux",
): string {
  const parts: string[] = [];
  if (ks.ctrl) parts.push("ctrl");
  if (ks.alt || ks.meta) {
    parts.push(platform === "macos" ? "opt" : "alt");
  }
  if (ks.shift) parts.push("shift");
  if (ks.super) {
    parts.push(platform === "macos" ? "cmd" : "super");
  }
  const displayKey = keyToDisplayName(ks.key);
  parts.push(displayKey);
  return parts.join("+");
}

export function chordToDisplayString(chord: Chord, platform: DisplayPlatform = "linux"): string {
  return chord.map((ks) => keystrokeToDisplayString(ks, platform)).join(" ");
}

export function parseBindings(blocks: KeybindingBlock[]): ParsedBinding[] {
  const bindings: ParsedBinding[] = [];
  for (const block of blocks) {
    for (const [key, action] of Object.entries(block.bindings)) {
      if (action === undefined) continue;
      bindings.push({
        chord: parseChord(key),
        action,
        context: block.context,
      });
    }
  }
  return bindings;
}

export const parseKeyChord = parseChord;

export function renderKeyChord(chords: Chord[]): string {
  if (chords.length === 0) return "";
  return chords.map((chord) => chordToDisplayString(chord)).join("/");
}
