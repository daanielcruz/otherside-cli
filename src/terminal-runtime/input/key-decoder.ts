import { Buffer } from "node:buffer";
import { getAttacherCaps } from "@/bootstrap/state.js";
import { PASTE_END, PASTE_START } from "@/terminal-runtime/terminal/control-sequences.js";
import { createTokenizer, type Tokenizer } from "@/terminal-runtime/terminal/sequence-tokens.js";
import { isEnvDefinedFalsy, isEnvTruthy } from "@/utils/envUtils.js";

const META_KEY_CODE_RE = /^(?:\x1b)([a-zA-Z0-9])$/;

function resolveBackspaceAsCtrlBackspace(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): boolean {
  const override = env.OTHERSIDE_BS_AS_CTRL_BACKSPACE;
  if (isEnvTruthy(override)) return true;
  if (isEnvDefinedFalsy(override)) return false;
  return platform === "win32" && env.TERM_PROGRAM !== "mintty" && env.TERM !== "cygwin";
}

function isBackspaceAsCtrlBackspace(): boolean {
  return resolveBackspaceAsCtrlBackspace("darwin", process.env);
}

const FN_KEY_RE = /^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/;

const CSI_U_RE = /^\x1b\[(\d+)(?:;(\d+))?u/;

const MODIFY_OTHER_KEYS_RE = /^\x1b\[27;(\d+);(\d+)~/;

const DECRPM_RE = /^\x1b\[\?(\d+);(\d+)\$y$/;

const THEME_NOTIFY_RE = /^\x1b\[\?997;([12])n$/;

const DA1_RE = /^\x1b\[\?([\d;]*)c$/;

const DA2_RE = /^\x1b\[>([\d;]*)c$/;

const KITTY_FLAGS_RE = /^\x1b\[\?(\d+)u$/;

const CURSOR_POSITION_RE = /^\x1b\[\?(\d+);(\d+)R$/;

const OSC_RESPONSE_RE = /^\x1b\](\d+);(.*?)(?:\x07|\x1b\\)$/s;

const XTVERSION_RE = /^\x1bP>\|(.*?)(?:\x07|\x1b\\)$/s;

const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

function buildPastedInputEvent(content: string): KeyEventData {
  return {
    kind: "key",
    name: "",
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: content,
    raw: content,
    isPasted: true,
  };
}

export const DECRPM_STATUS_CODES = {
  NOT_RECOGNIZED: 0,
  SET: 1,
  RESET: 2,
  PERMANENTLY_SET: 3,
  PERMANENTLY_RESET: 4,
} as const;

export type TerminalControlResponse =
  | { type: "decrpm"; mode: number; status: number }
  | { type: "themeNotify"; dark: boolean }
  | { type: "da1"; params: number[] }
  | { type: "da2"; params: number[] }
  | { type: "kittyKeyboard"; flags: number }
  | { type: "cursorPosition"; row: number; col: number }
  | { type: "osc"; code: number; data: string }
  | { type: "xtversion"; name: string };

function parseControlSequence(s: string): TerminalControlResponse | null {
  if (s.startsWith("\x1b[")) {
    let m: RegExpExecArray | null;

    if ((m = DECRPM_RE.exec(s))) {
      return {
        type: "decrpm",
        mode: parseInt(m[1]!, 10),
        status: parseInt(m[2]!, 10),
      };
    }

    if ((m = THEME_NOTIFY_RE.exec(s))) {
      return { type: "themeNotify", dark: m[1] === "1" };
    }

    if ((m = DA1_RE.exec(s))) {
      return { type: "da1", params: parseNumericCSIParams(m[1]!) };
    }

    if ((m = DA2_RE.exec(s))) {
      return { type: "da2", params: parseNumericCSIParams(m[1]!) };
    }

    if ((m = KITTY_FLAGS_RE.exec(s))) {
      return { type: "kittyKeyboard", flags: parseInt(m[1]!, 10) };
    }

    if ((m = CURSOR_POSITION_RE.exec(s))) {
      return {
        type: "cursorPosition",
        row: parseInt(m[1]!, 10),
        col: parseInt(m[2]!, 10),
      };
    }

    return null;
  }

  if (s.startsWith("\x1b]")) {
    const m = OSC_RESPONSE_RE.exec(s);
    if (m) {
      return { type: "osc", code: parseInt(m[1]!, 10), data: m[2]! };
    }
  }

  if (s.startsWith("\x1bP")) {
    const m = XTVERSION_RE.exec(s);
    if (m) {
      return { type: "xtversion", name: m[1]! };
    }
  }

  return null;
}

const themeNotifySubscribers = new Set<() => void>();

export function subscribeTerminalThemeNotify(listener: () => void): () => void {
  themeNotifySubscribers.add(listener);
  return () => {
    themeNotifySubscribers.delete(listener);
  };
}

export function notifyTerminalThemeNotify(): void {
  for (const listener of themeNotifySubscribers) listener();
}

function parseNumericCSIParams(params: string): number[] {
  if (!params) return [];
  return params.split(";").map((p) => parseInt(p, 10));
}

export type InputParserState = {
  mode: "NORMAL" | "IN_PASTE";
  incomplete: string;
  pasteBuffer: string;

  _tokenizer?: Tokenizer;
};

export const INITIAL_PARSER_STATE: InputParserState = {
  mode: "NORMAL",
  incomplete: "",
  pasteBuffer: "",
};

function normalizeBufferInput(input: Buffer | string): string {
  if (Buffer.isBuffer(input)) {
    if (input[0]! > 127 && input[1] === undefined) {
      (input[0] as unknown as number) -= 128;
      return "\x1b" + String(input);
    } else {
      return String(input);
    }
  } else if (input !== undefined && typeof input !== "string") {
    return String(input);
  } else if (!input) {
    return "";
  } else {
    return input;
  }
}

function splitControlRuns(value: string): string[] {
  if (value.length <= 1) return [value];
  let hasControl = false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      hasControl = true;
      break;
    }
  }
  if (!hasControl) return [value];
  const pieces: string[] = [];
  let textStart = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      if (i > textStart) pieces.push(value.slice(textStart, i));
      pieces.push(value[i] as string);
      textStart = i + 1;
    }
  }
  if (textStart < value.length) pieces.push(value.slice(textStart));
  return pieces;
}

export function parseInputSequence(
  prevState: InputParserState,
  input: Buffer | string | null = "",
): [InputEvent[], InputParserState] {
  const isFlush = input === null;
  const inputString = isFlush ? "" : normalizeBufferInput(input);

  const tokenizer = prevState._tokenizer ?? createTokenizer({ x10Mouse: true });

  const tokens = isFlush ? tokenizer.flush() : tokenizer.feed(inputString);

  const keys: InputEvent[] = [];
  let inPaste = prevState.mode === "IN_PASTE";
  let pasteBuffer = prevState.pasteBuffer;

  for (const token of tokens) {
    if (token.type === "sequence") {
      if (token.value === PASTE_START) {
        inPaste = true;
        pasteBuffer = "";
      } else if (token.value === PASTE_END) {
        keys.push(buildPastedInputEvent(pasteBuffer));
        inPaste = false;
        pasteBuffer = "";
      } else if (inPaste) {
        pasteBuffer += token.value;
      } else {
        const response = parseControlSequence(token.value);
        if (response) {
          keys.push({ kind: "response", sequence: token.value, response });
        } else {
          const mouse = parseSGRMouseEvent(token.value);
          if (mouse) {
            keys.push(mouse);
          } else {
            keys.push(parseKeyEvent(token.value));
          }
        }
      }
    } else if (token.type === "text") {
      if (inPaste) {
        pasteBuffer += token.value;
      } else if (
        /^\[<\d+;\d+;\d+[Mm]$/.test(token.value) ||
        /^\[M[\x60-\x7f][\x20-\uffff]{2}$/.test(token.value)
      ) {
        const resynthesized = "\x1b" + token.value;
        const mouse = parseSGRMouseEvent(resynthesized);
        keys.push(mouse ?? parseKeyEvent(resynthesized));
      } else {
        for (const piece of splitControlRuns(token.value)) {
          keys.push(parseKeyEvent(piece));
        }
      }
    }
  }

  if (isFlush && inPaste) {
    if (pasteBuffer) {
      keys.push(buildPastedInputEvent(pasteBuffer));
    }
    inPaste = false;
    pasteBuffer = "";
  }

  const newState: InputParserState = {
    mode: inPaste ? "IN_PASTE" : "NORMAL",
    incomplete: tokenizer.buffer(),
    pasteBuffer,
    _tokenizer: tokenizer,
  };

  return [keys, newState];
}

const keyCodeLookup: Record<string, string> = {
  OP: "f1",
  OQ: "f2",
  OR: "f3",
  OS: "f4",

  Op: "0",
  Oq: "1",
  Or: "2",
  Os: "3",
  Ot: "4",
  Ou: "5",
  Ov: "6",
  Ow: "7",
  Ox: "8",
  Oy: "9",

  Oj: "*",
  Ok: "+",
  Ol: ",",
  Om: "-",
  On: ".",
  Oo: "/",
  OM: "return",

  "[11~": "f1",
  "[12~": "f2",
  "[13~": "f3",
  "[14~": "f4",

  "[[A": "f1",
  "[[B": "f2",
  "[[C": "f3",
  "[[D": "f4",
  "[[E": "f5",

  "[15~": "f5",
  "[17~": "f6",
  "[18~": "f7",
  "[19~": "f8",
  "[20~": "f9",
  "[21~": "f10",
  "[23~": "f11",
  "[24~": "f12",

  "[A": "up",
  "[B": "down",
  "[C": "right",
  "[D": "left",
  "[E": "clear",
  "[F": "end",
  "[H": "home",

  OA: "up",
  OB: "down",
  OC: "right",
  OD: "left",
  OE: "clear",
  OF: "end",
  OH: "home",

  "[1~": "home",
  "[2~": "insert",
  "[3~": "delete",
  "[4~": "end",
  "[5~": "pageup",
  "[6~": "pagedown",

  "[[5~": "pageup",
  "[[6~": "pagedown",

  "[7~": "home",
  "[8~": "end",

  "[a": "up",
  "[b": "down",
  "[c": "right",
  "[d": "left",
  "[e": "clear",

  "[2$": "insert",
  "[3$": "delete",
  "[5$": "pageup",
  "[6$": "pagedown",
  "[7$": "home",
  "[8$": "end",

  Oa: "up",
  Ob: "down",
  Oc: "right",
  Od: "left",
  Oe: "clear",

  "[2^": "insert",
  "[3^": "delete",
  "[5^": "pageup",
  "[6^": "pagedown",
  "[7^": "home",
  "[8^": "end",

  "[Z": "tab",
};

export const multiCharKeyNames = [
  ...Object.values(keyCodeLookup).filter((v) => v.length > 1),

  "escape",
  "backspace",
  "wheelup",
  "wheeldown",
  "mouse",
];

const isShiftModifiedKey = (code: string): boolean => {
  return ["[a", "[b", "[c", "[d", "[e", "[2$", "[3$", "[5$", "[6$", "[7$", "[8$", "[Z"].includes(
    code,
  );
};

const isCtrlModifiedKey = (code: string): boolean => {
  return ["Oa", "Ob", "Oc", "Od", "Oe", "[2^", "[3^", "[5^", "[6^", "[7^", "[8^"].includes(code);
};

function altGrAsTextMode(
  env: NodeJS.ProcessEnv,
  fallback: boolean | undefined,
): "force" | "off" | "auto" {
  const raw = env.OTHERSIDE_ALTGR_AS_TEXT;
  if (isEnvTruthy(raw)) return "force";
  if (isEnvDefinedFalsy(raw)) return "off";
  return (fallback ?? !!env.WT_SESSION) ? "auto" : "off";
}

function getAltGrAsTextMode(): "force" | "off" | "auto" {
  return altGrAsTextMode(process.env, getAttacherCaps()?.wtSession);
}

function isPrintableCodepoint(codepoint: number): boolean {
  return (codepoint > 32 && codepoint < 127) || (codepoint >= 160 && codepoint < 55296);
}

function isAlphanumericCodepoint(codepoint: number): boolean {
  return (
    (codepoint >= 48 && codepoint <= 57) ||
    (codepoint >= 65 && codepoint <= 90) ||
    (codepoint >= 97 && codepoint <= 122)
  );
}

function shouldTreatAsAltGrText(
  mods: { ctrl: boolean; meta: boolean; super: boolean },
  codepoint: number,
): boolean {
  if (!(mods.ctrl && mods.meta) || mods.super) return false;
  if (!isPrintableCodepoint(codepoint)) return false;
  const mode = getAltGrAsTextMode();
  if (mode === "off") return false;
  return mode === "force" || !isAlphanumericCodepoint(codepoint);
}

function createAltGrTextKey(sequence: string, codepoint: number, shift: boolean): KeyEventData {
  return {
    kind: "key",
    name: String.fromCodePoint(codepoint),
    fn: false,
    ctrl: false,
    meta: false,
    shift,
    option: false,
    super: false,
    sequence,
    raw: sequence,
    isPasted: false,
  };
}

function decodeModifierBits(modifier: number): {
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
  super: boolean;
} {
  const m = modifier - 1;
  return {
    shift: !!(m & 1),
    meta: !!(m & 2),
    ctrl: !!(m & 4),
    super: !!(m & 8),
  };
}

function codePointToKeyName(keycode: number): string | undefined {
  switch (keycode) {
    case 9:
      return "tab";
    case 13:
      return "return";
    case 27:
      return "escape";
    case 32:
      return "space";
    case 127:
      return "backspace";

    case 57399:
      return "0";
    case 57400:
      return "1";
    case 57401:
      return "2";
    case 57402:
      return "3";
    case 57403:
      return "4";
    case 57404:
      return "5";
    case 57405:
      return "6";
    case 57406:
      return "7";
    case 57407:
      return "8";
    case 57408:
      return "9";
    case 57409:
      return ".";
    case 57410:
      return "/";
    case 57411:
      return "*";
    case 57412:
      return "-";
    case 57413:
      return "+";
    case 57414:
      return "return";
    case 57415:
      return "=";
    default:
      if (keycode >= 32 && keycode <= 126) {
        return String.fromCharCode(keycode).toLowerCase();
      }
      return undefined;
  }
}

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

export type ResponseEventData = {
  kind: "response";

  sequence: string;
  response: TerminalControlResponse;
};

export type MouseEventData = {
  kind: "mouse";

  button: number;

  action: "press" | "release";

  col: number;

  row: number;
  sequence: string;
};

export type InputEvent = KeyEventData | MouseEventData | ResponseEventData;

function parseSGRMouseEvent(s: string): MouseEventData | null {
  const match = SGR_MOUSE_RE.exec(s);
  if (!match) return null;
  const button = parseInt(match[1]!, 10);

  if ((button & 0x40) !== 0) return null;
  return {
    kind: "mouse",
    button,
    action: match[4] === "M" ? "press" : "release",
    col: parseInt(match[2]!, 10),
    row: parseInt(match[3]!, 10),
    sequence: s,
  };
}

function parseKeyEvent(s: string = ""): KeyEventData {
  let parts;

  const key: KeyEventData = {
    kind: "key",
    name: "",
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: s,
    raw: s,
    isPasted: false,
  };

  key.sequence = key.sequence || s || key.name;

  let match: RegExpExecArray | null;
  if ((match = CSI_U_RE.exec(s))) {
    const codepoint = parseInt(match[1]!, 10);

    const modifier = match[2] ? parseInt(match[2], 10) : 1;
    const mods = decodeModifierBits(modifier);
    if (shouldTreatAsAltGrText(mods, codepoint)) {
      return createAltGrTextKey(s, codepoint, mods.shift);
    }
    const name = codePointToKeyName(codepoint);
    return {
      kind: "key",
      name,
      fn: false,
      ctrl: mods.ctrl,
      meta: mods.meta,
      shift: mods.shift,
      option: false,
      super: mods.super,
      sequence: s,
      raw: s,
      isPasted: false,
    };
  }

  if ((match = MODIFY_OTHER_KEYS_RE.exec(s))) {
    const mods = decodeModifierBits(parseInt(match[1]!, 10));
    const keycode = parseInt(match[2]!, 10);
    if (shouldTreatAsAltGrText(mods, keycode)) {
      return createAltGrTextKey(s, keycode, mods.shift);
    }
    const name = codePointToKeyName(keycode);
    return {
      kind: "key",
      name,
      fn: false,
      ctrl: mods.ctrl,
      meta: mods.meta,
      shift: mods.shift,
      option: false,
      super: mods.super,
      sequence: s,
      raw: s,
      isPasted: false,
    };
  }

  if ((match = SGR_MOUSE_RE.exec(s))) {
    const button = parseInt(match[1]!, 10);
    if ((button & 0x43) === 0x40) return buildNavigationKey(s, "wheelup", false);
    if ((button & 0x43) === 0x41) return buildNavigationKey(s, "wheeldown", false);

    return buildNavigationKey(s, "mouse", false);
  }

  if (s.length === 6 && s.startsWith("\x1b[M")) {
    const button = s.charCodeAt(3) - 32;
    if ((button & 0x43) === 0x40) return buildNavigationKey(s, "wheelup", false);
    if ((button & 0x43) === 0x41) return buildNavigationKey(s, "wheeldown", false);
    return buildNavigationKey(s, "mouse", false);
  }

  if (s === "\r") {
    key.raw = undefined;
    key.name = "return";
  } else if (s === "\n") {
    key.name = "enter";
  } else if (s === "\t") {
    key.name = "tab";
  } else if (s === "\b" || s === "\x1b\b") {
    key.name = "backspace";
    key.meta = s.charAt(0) === "\x1b";
    if (isBackspaceAsCtrlBackspace()) {
      key.ctrl = true;
    }
  } else if (s === "\x7f" || s === "\x1b\x7f") {
    key.name = "backspace";
    key.meta = s.charAt(0) === "\x1b";
  } else if (s === "\x1b" || s === "\x1b\x1b") {
    key.name = "escape";
    key.meta = s.length === 2;
  } else if (s === " " || s === "\x1b ") {
    key.name = "space";
    key.meta = s.length === 2;
  } else if (s === "\x1f") {
    key.name = "_";
    key.ctrl = true;
  } else if (s <= "\x1a" && s.length === 1) {
    key.name = String.fromCharCode(s.charCodeAt(0) + "a".charCodeAt(0) - 1);
    key.ctrl = true;
  } else if (s.length === 1 && s >= "0" && s <= "9") {
    key.name = "number";
  } else if (s.length === 1 && s >= "a" && s <= "z") {
    key.name = s;
  } else if (s.length === 1 && s >= "A" && s <= "Z") {
    key.name = s.toLowerCase();
    key.shift = true;
  } else if ((parts = META_KEY_CODE_RE.exec(s))) {
    key.meta = true;
    key.shift = /^[A-Z]$/.test(parts[1]!);
  } else if ((parts = FN_KEY_RE.exec(s))) {
    const segs = [...s];

    if (segs[0] === "\u001b" && segs[1] === "\u001b") {
      key.option = true;
    }

    const code = [parts[1], parts[2], parts[4], parts[6]].filter(Boolean).join("");

    const modifier = ((parts[3] || parts[5] || 1) as number) - 1;

    key.ctrl = !!(modifier & 4);
    key.meta = !!(modifier & 2);
    key.super = !!(modifier & 8);
    key.shift = !!(modifier & 1);
    key.code = code;

    key.name = keyCodeLookup[code];
    key.shift = isShiftModifiedKey(code) || key.shift;
    key.ctrl = isCtrlModifiedKey(code) || key.ctrl;
  }

  if (key.raw === "\x1Bb") {
    key.meta = true;
    key.name = "left";
  } else if (key.raw === "\x1Bf") {
    key.meta = true;
    key.name = "right";
  }

  switch (s) {
    case "\u001b[1~":
      return buildNavigationKey(s, "home", false);
    case "\u001b[4~":
      return buildNavigationKey(s, "end", false);
    case "\u001b[5~":
      return buildNavigationKey(s, "pageup", false);
    case "\u001b[6~":
      return buildNavigationKey(s, "pagedown", false);
    case "\u001b[1;5D":
      return buildNavigationKey(s, "left", true);
    case "\u001b[1;5C":
      return buildNavigationKey(s, "right", true);
  }

  return key;
}

function buildNavigationKey(s: string, name: string, ctrl: boolean): KeyEventData {
  return {
    kind: "key",
    name,
    ctrl,
    meta: false,
    shift: false,
    option: false,
    super: false,
    fn: false,
    sequence: s,
    raw: s,
    isPasted: false,
  };
}
