import { Buffer } from "node:buffer";
import { isEnvDefinedFalsy, isEnvTruthy } from "@/kernel/std/proc/env.ts";
import { readAttacherCapabilities } from "@/terminal-runtime/host/environment.js";
import { resolveCodePointName, resolveLegacyKey } from "@/terminal-runtime/input/key-names.js";
import { PASTE_END, PASTE_START } from "@/terminal-runtime/terminal/control-sequences.js";
import {
  type BoundaryScanner,
  type InputFragment,
  openBoundaryScanner,
} from "@/terminal-runtime/terminal/stream-boundaries.js";

export type TerminalKeyState = {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageDown: boolean;
  pageUp: boolean;
  wheelUp: boolean;
  wheelDown: boolean;
  home: boolean;
  end: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  fn: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
  super: boolean;
};

export type KeyEventData = {
  kind: "key";
  fn: boolean;
  name: string | undefined;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  option: boolean;
  super: boolean;
  sequence: string | undefined;
  raw: string | undefined;
  code?: string;
  isPasted: boolean;
};

export type MouseEventData = {
  kind: "mouse";
  button: number;
  action: "press" | "release";
  col: number;
  row: number;
  sequence: string;
};

export type FocusEventData = {
  kind: "focus";
  focused: boolean;
};

export type InputEvent = KeyEventData | MouseEventData | FocusEventData;

// Focus reporting (DECSET 1004) reports terminal focus as CSI I / CSI O. Neither
// is a key sequence (Shift+Tab is CSI Z, SS3-O keys carry no `[`), so decoding them
// as focus events never steals a keystroke.
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

function decodeFocus(token: string): FocusEventData | null {
  if (token === FOCUS_IN) return { kind: "focus", focused: true };
  if (token === FOCUS_OUT) return { kind: "focus", focused: false };
  return null;
}

export type InputDecodeState = {
  phase: "idle" | "paste";
  pending: string;
  accumulatedPaste: string;
  segmenter?: BoundaryScanner;
};

export const FRESH_INPUT_DECODE_STATE: InputDecodeState = {
  phase: "idle",
  pending: "",
  accumulatedPaste: "",
};

const IGNORED_TERMINAL_REPLIES = [
  /^\x1b\[\?\d+;\d+\$y$/,
  /^\x1b\[\?997;[12]n$/,
  /^\x1b\[\?[\d;]*c$/,
  /^\x1b\[>[\d;]*c$/,
  /^\x1b\[\?\d+u$/,
  /^\x1b\[\?\d+;\d+(?:;\d+)?R$/,
  /^\x1b\]\d+;.*?(?:\x07|\x1b\\)$/s,
  /^\x1bP>\|.*?(?:\x07|\x1b\\)$/s,
];

function isIgnoredTerminalReply(sequence: string): boolean {
  return IGNORED_TERMINAL_REPLIES.some((pattern) => pattern.test(sequence));
}

const sgrMousePattern = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
const orphanSgrMousePattern = /^\[<\d+;\d+;\d+[Mm]$/;
const orphanX10MousePattern = /^\[M[\x60-\x7f][\x20-\uffff]{2}$/;

function decodeMouse(sequence: string): MouseEventData | null {
  const capture = sgrMousePattern.exec(sequence);
  if (!capture) return null;
  const button = Number(capture[1]);
  if (button & 0x40) return null;
  return {
    kind: "mouse",
    button,
    action: capture[4] === "M" ? "press" : "release",
    col: Number(capture[2]),
    row: Number(capture[3]),
    sequence,
  };
}

function pastedKey(sequence: string): KeyEventData {
  return baseKey(sequence, { name: "", isPasted: true });
}

function baseKey(
  sequence: string,
  changes: Partial<Omit<KeyEventData, "kind" | "sequence" | "raw">> & {
    raw?: string | undefined;
  } = {},
): KeyEventData {
  return {
    kind: "key",
    sequence,
    raw: sequence,
    isPasted: false,
    name: "",
    option: false,
    super: false,
    meta: false,
    shift: false,
    ctrl: false,
    fn: false,
    ...changes,
  };
}

function modifierFlags(encoded: number): Pick<KeyEventData, "shift" | "meta" | "ctrl" | "super"> {
  const bits = encoded - 1;
  return {
    shift: Boolean(bits & 1),
    meta: Boolean(bits & 2),
    ctrl: Boolean(bits & 4),
    super: Boolean(bits & 8),
  };
}

function altGrMode(): "force" | "off" | "auto" {
  const configured = process.env.OTHERSIDE_ALTGR_AS_TEXT;
  if (isEnvTruthy(configured)) return "force";
  if (isEnvDefinedFalsy(configured)) return "off";
  return (readAttacherCapabilities()?.wtSession ?? Boolean(process.env.WT_SESSION))
    ? "auto"
    : "off";
}

function isAltGrText(
  flags: Pick<KeyEventData, "ctrl" | "meta" | "super">,
  codePoint: number,
): boolean {
  if (!flags.ctrl || !flags.meta || flags.super) return false;
  const printable = (codePoint > 32 && codePoint < 127) || (codePoint >= 160 && codePoint < 55296);
  if (!printable) return false;
  const mode = altGrMode();
  if (mode === "off") return false;
  const asciiLetterOrDigit =
    (codePoint >= 48 && codePoint <= 57) ||
    (codePoint >= 65 && codePoint <= 90) ||
    (codePoint >= 97 && codePoint <= 122);
  return mode === "force" || !asciiLetterOrDigit;
}

function decodeExtendedKey(sequence: string): KeyEventData | null {
  const csiU = /^\x1b\[(\d+)(?:;(\d+))?u/.exec(sequence);
  const modifiedOther = /^\x1b\[27;(\d+);(\d+)~/.exec(sequence);
  if (!csiU && !modifiedOther) return null;

  const codePoint = Number(csiU?.[1] ?? modifiedOther?.[2]);
  const flags = modifierFlags(Number(csiU?.[2] ?? modifiedOther?.[1] ?? 1));
  if (isAltGrText(flags, codePoint)) {
    return baseKey(sequence, {
      name: String.fromCodePoint(codePoint),
      shift: flags.shift,
    });
  }
  return baseKey(sequence, { name: resolveCodePointName(codePoint), ...flags });
}

function navigationKey(sequence: string, name: string, ctrl = false): KeyEventData {
  return baseKey(sequence, { name, ctrl });
}

function decodeMouseKey(sequence: string): KeyEventData | null {
  const sgr = sgrMousePattern.exec(sequence);
  const x10 = sequence.length === 6 && sequence.startsWith("\x1b[M");
  if (!sgr && !x10) return null;
  const button = sgr ? Number(sgr[1]) : sequence.charCodeAt(3) - 32;
  const direction = button & 0x43;
  if (direction === 0x40) return navigationKey(sequence, "wheelup");
  if (direction === 0x41) return navigationKey(sequence, "wheeldown");
  return navigationKey(sequence, "mouse");
}

function ctrlBackspaceEnabled(): boolean {
  const configured = process.env.OTHERSIDE_BS_AS_CTRL_BACKSPACE;
  if (isEnvTruthy(configured)) return true;
  if (isEnvDefinedFalsy(configured)) return false;
  return false;
}

const fixedNavigation: Readonly<Record<string, { name: string; ctrl?: true }>> = {
  "\x1b[1~": { name: "home" },
  "\x1b[4~": { name: "end" },
  "\x1b[5~": { name: "pageup" },
  "\x1b[6~": { name: "pagedown" },
  "\x1b[1;5D": { name: "left", ctrl: true },
  "\x1b[1;5C": { name: "right", ctrl: true },
};

function decodeLegacyKey(sequence = ""): KeyEventData {
  const extended = decodeExtendedKey(sequence);
  if (extended) return extended;
  const mouse = decodeMouseKey(sequence);
  if (mouse) return mouse;

  let key = baseKey(sequence);
  if (sequence === "\r") key = baseKey(sequence, { name: "return", raw: undefined });
  else if (sequence === "\x1b\r") key = baseKey(sequence, { name: "return", meta: true });
  else if (sequence === "\n") key.name = "enter";
  else if (sequence === "\t") key.name = "tab";
  else if (sequence === "\b" || sequence === "\x1b\b") {
    key.name = "backspace";
    key.meta = sequence.startsWith("\x1b");
    key.ctrl = ctrlBackspaceEnabled();
  } else if (sequence === "\x7f" || sequence === "\x1b\x7f") {
    key.name = "backspace";
    key.meta = sequence.startsWith("\x1b");
  } else if (sequence === "\x1b" || sequence === "\x1b\x1b") {
    key.name = "escape";
    key.meta = sequence.length === 2;
  } else if (sequence === " " || sequence === "\x1b ") {
    key.name = "space";
    key.meta = sequence.length === 2;
  } else if (sequence === "\x1f") {
    key.name = "_";
    key.ctrl = true;
  } else if (sequence.length === 1 && sequence <= "\x1a") {
    key.name = String.fromCharCode(sequence.charCodeAt(0) + 96);
    key.ctrl = true;
  } else if (/^[0-9]$/.test(sequence)) key.name = "number";
  else if (/^[a-z]$/.test(sequence)) key.name = sequence;
  else if (/^[A-Z]$/.test(sequence)) {
    key.name = sequence.toLowerCase();
    key.shift = true;
  } else if (/^\x1b[a-zA-Z0-9]$/.test(sequence)) {
    key.meta = true;
    key.shift = /[A-Z]$/.test(sequence);
  } else {
    key = decodeFunctionKey(sequence, key);
  }

  if (sequence === "\x1bb") {
    key.name = "left";
    key.meta = true;
  } else if (sequence === "\x1bf") {
    key.name = "right";
    key.meta = true;
  }

  const override = fixedNavigation[sequence];
  return override ? navigationKey(sequence, override.name, override.ctrl) : key;
}

function decodeFunctionKey(sequence: string, key: KeyEventData): KeyEventData {
  const capture = /^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/.exec(
    sequence,
  );
  if (!capture) return key;

  const code = [capture[1], capture[2], capture[4], capture[6]].filter(Boolean).join("");
  const flags = modifierFlags(Number(capture[3] ?? capture[5] ?? 1));
  const legacy = resolveLegacyKey(code);
  return {
    ...key,
    ...flags,
    name: legacy.name,
    shift: flags.shift || legacy.shift,
    ctrl: flags.ctrl || legacy.ctrl,
    option: sequence.startsWith("\x1b\x1b"),
    code,
  };
}

function stringifyInput(input: Buffer | string): string {
  if (!Buffer.isBuffer(input)) return input ? String(input) : "";
  if (input.length === 1 && input[0]! > 127) {
    input[0] = input[0]! - 128;
    return `\x1b${String(input)}`;
  }
  return String(input);
}

const pairedMetaControls = new Set([0x08, 0x0d, 0x7f]);

function partitionText(value: string): string[] {
  if (
    value.length <= 1 ||
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) {
    return [value];
  }

  const partitions: string[] = [];
  let printableStart = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0x20 && code !== 0x7f) continue;
    if (index > printableStart) partitions.push(value.slice(printableStart, index));
    if (code === 0x1b && pairedMetaControls.has(value.charCodeAt(index + 1))) {
      partitions.push(value.slice(index, index + 2));
      index++;
    } else {
      partitions.push(value[index]!);
    }
    printableStart = index + 1;
  }
  if (printableStart < value.length) partitions.push(value.slice(printableStart));
  return partitions;
}

type Demux = {
  events: InputEvent[];
  inPaste: boolean;
  paste: string;
};

function acceptSequence(token: string, demux: Demux): void {
  if (token === PASTE_START) {
    demux.inPaste = true;
    demux.paste = "";
    return;
  }
  if (token === PASTE_END) {
    demux.events.push(pastedKey(demux.paste));
    demux.inPaste = false;
    demux.paste = "";
    return;
  }
  if (demux.inPaste) {
    demux.paste += token;
    return;
  }

  if (isIgnoredTerminalReply(token)) return;
  const focus = decodeFocus(token);
  if (focus) {
    demux.events.push(focus);
    return;
  }
  demux.events.push(decodeMouse(token) ?? decodeLegacyKey(token));
}

function acceptText(token: string, demux: Demux): void {
  if (demux.inPaste) {
    demux.paste += token;
    return;
  }
  if (orphanSgrMousePattern.test(token) || orphanX10MousePattern.test(token)) {
    const restored = `\x1b${token}`;
    demux.events.push(decodeMouse(restored) ?? decodeLegacyKey(restored));
    return;
  }
  for (const part of partitionText(token)) {
    demux.events.push(decodeLegacyKey(part));
  }
}

function collectDecodedInput(fragments: InputFragment[], state: InputDecodeState): Demux {
  const batch: Demux = {
    events: [],
    inPaste: state.phase === "paste",
    paste: state.accumulatedPaste,
  };
  for (const fragment of fragments) {
    if (fragment.type === "sequence") acceptSequence(fragment.value, batch);
    else acceptText(fragment.value, batch);
  }
  return batch;
}

export function decodeTerminalInput(
  previous: InputDecodeState,
  input: Buffer | string | null = "",
): [InputEvent[], InputDecodeState] {
  const segmenter = previous.segmenter ?? openBoundaryScanner({ legacyMousePayload: true });
  const shouldDrain = input === null;
  const fragments = shouldDrain ? segmenter.drain() : segmenter.accept(stringifyInput(input));
  const batch = collectDecodedInput(fragments, previous);

  if (shouldDrain && batch.inPaste) {
    if (batch.paste) batch.events.push(pastedKey(batch.paste));
    batch.inPaste = false;
    batch.paste = "";
  }

  return [
    batch.events,
    {
      phase: batch.inPaste ? "paste" : "idle",
      pending: segmenter.remainder(),
      accumulatedPaste: batch.paste,
      segmenter,
    },
  ];
}
