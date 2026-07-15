import { Event } from "@/terminal-runtime/input/base-event.js";
import { type KeyEventData, multiCharKeyNames } from "@/terminal-runtime/input/key-decoder.js";

export type TerminalKey = {
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

function decodeKeypress(keypress: KeyEventData): [TerminalKey, string] {
  const key: TerminalKey = {
    upArrow: keypress.name === "up",
    downArrow: keypress.name === "down",
    leftArrow: keypress.name === "left",
    rightArrow: keypress.name === "right",
    pageDown: keypress.name === "pagedown",
    pageUp: keypress.name === "pageup",
    wheelUp: keypress.name === "wheelup",
    wheelDown: keypress.name === "wheeldown",
    home: keypress.name === "home",
    end: keypress.name === "end",
    return: keypress.name === "return",
    escape: keypress.name === "escape",
    fn: keypress.fn,
    ctrl: keypress.ctrl,
    shift: keypress.shift,
    tab: keypress.name === "tab",
    backspace: keypress.name === "backspace",
    delete: keypress.name === "delete",

    meta: keypress.meta || keypress.name === "escape" || keypress.option,

    super: keypress.super,
  };

  let input = keypress.ctrl ? keypress.name : keypress.sequence;

  if (input === undefined) {
    input = "";
  }

  if (keypress.ctrl && input === "space") {
    input = " ";
  }

  if (keypress.code && !keypress.name) {
    input = "";
  }

  if (!keypress.name && /^\[<\d+;\d+;\d+[Mm]/.test(input)) {
    input = "";
  }

  if (input.startsWith("\u001B")) {
    input = input.slice(1);
  }

  let processedAsSpecialSequence = false;

  if (/^\[\d/.test(input) && input.endsWith("u")) {
    if (!keypress.name) {
      input = "";
    } else {
      input = keypress.name === "space" ? " " : keypress.name === "escape" ? "" : keypress.name;
    }
    processedAsSpecialSequence = true;
  }

  if (input.startsWith("[27;") && input.endsWith("~")) {
    if (!keypress.name) {
      input = "";
    } else {
      input = keypress.name === "space" ? " " : keypress.name === "escape" ? "" : keypress.name;
    }
    processedAsSpecialSequence = true;
  }

  if (input.startsWith("O") && input.length === 2 && keypress.name && keypress.name.length === 1) {
    input = keypress.name;
    processedAsSpecialSequence = true;
  }

  if (!processedAsSpecialSequence && keypress.name && multiCharKeyNames.includes(keypress.name)) {
    input = "";
  }

  if (input.length === 1 && typeof input[0] === "string" && input[0] >= "A" && input[0] <= "Z") {
    key.shift = true;
  }

  return [key, input];
}

export class KeyStroke extends Event {
  readonly keypress: KeyEventData;
  readonly key: TerminalKey;
  readonly input: string;

  constructor(keypress: KeyEventData) {
    super();
    const [key, input] = decodeKeypress(keypress);

    this.keypress = keypress;
    this.key = key;
    this.input = input;
  }
}
