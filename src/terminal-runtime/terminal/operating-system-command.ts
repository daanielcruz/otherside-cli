import { BEL, ESC, ESC_TYPE, SEP } from "@/terminal-runtime/terminal/ansi-control.js";
import type {
  Action,
  Color,
  TabStatusAction,
} from "@/terminal-runtime/terminal/protocol-contracts.js";
import { env } from "@/utils/env.js";

export const SEQUENCE_PREFIX = ESC + String.fromCharCode(ESC_TYPE.OSC);

export const ST = ESC + "\\";

export function osc(...parts: (string | number)[]): string {
  const terminator = env.terminal === "kitty" ? ST : BEL;
  return `${SEQUENCE_PREFIX}${parts.join(SEP)}${terminator}`;
}

export function wrapForSessionManager(sequence: string): string {
  if (process.env.TMUX) {
    const escaped = sequence.replaceAll("\x1b", "\x1b\x1b");
    return `\x1bPtmux;${escaped}\x1b\\`;
  }
  if (process.env.STY) {
    return `\x1bP${sequence}\x1b\\`;
  }
  return sequence;
}

export const OSC = {
  SET_TITLE_AND_ICON: 0,
  SET_ICON: 1,
  SET_TITLE: 2,
  SET_COLOR: 4,
  SET_CWD: 7,
  HYPERLINK: 8,
  ITERM2_COMMANDS: 9,
  SET_FG_COLOR: 10,
  SET_BG_COLOR: 11,
  SET_CURSOR_COLOR: 12,
  KITTY: 99,
  RESET_COLOR: 104,
  RESET_FG_COLOR: 110,
  RESET_BG_COLOR: 111,
  RESET_CURSOR_COLOR: 112,
  SEMANTIC_PROMPT: 133,
  GHOSTTY: 777,
  TAB_STATUS: 21337,
} as const;

export function parseSequence(content: string): Action | null {
  const semicolonIdx = content.indexOf(";");
  const command = semicolonIdx >= 0 ? content.slice(0, semicolonIdx) : content;
  const data = semicolonIdx >= 0 ? content.slice(semicolonIdx + 1) : "";

  const commandNum = parseInt(command, 10);

  if (commandNum === OSC.SET_TITLE_AND_ICON) {
    return { type: "title", action: { type: "both", title: data } };
  }
  if (commandNum === OSC.SET_ICON) {
    return { type: "title", action: { type: "iconName", name: data } };
  }
  if (commandNum === OSC.SET_TITLE) {
    return { type: "title", action: { type: "windowTitle", title: data } };
  }

  if (commandNum === OSC.HYPERLINK) {
    const parts = data.split(";");
    const paramsStr = parts[0] ?? "";
    const url = parts.slice(1).join(";");

    if (url === "") {
      return { type: "link", action: { type: "end" } };
    }

    const params: Record<string, string> = {};
    if (paramsStr) {
      for (const pair of paramsStr.split(":")) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx >= 0) {
          params[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
        }
      }
    }

    return {
      type: "link",
      action: {
        type: "start",
        url,
        params: Object.keys(params).length > 0 ? params : undefined,
      },
    };
  }

  if (commandNum === OSC.TAB_STATUS) {
    return { type: "tabStatus", action: parseTabFields(data) };
  }

  return { type: "unknown", sequence: `\x1b]${content}` };
}

export function parseColorSpec(spec: string): Color | null {
  const hex = spec.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex) {
    return {
      type: "rgb",
      r: parseInt(hex[1]!, 16),
      g: parseInt(hex[2]!, 16),
      b: parseInt(hex[3]!, 16),
    };
  }
  const rgb = spec.match(/^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i);
  if (rgb) {
    const scale = (s: string) => Math.round((parseInt(s, 16) / (16 ** s.length - 1)) * 255);
    return {
      type: "rgb",
      r: scale(rgb[1]!),
      g: scale(rgb[2]!),
      b: scale(rgb[3]!),
    };
  }
  return null;
}

function parseTabFields(data: string): TabStatusAction {
  const action: TabStatusAction = {};
  for (const [key, value] of extractTabPairs(data)) {
    switch (key) {
      case "indicator":
        action.indicator = value === "" ? null : parseColorSpec(value);
        break;
      case "status":
        action.status = value === "" ? null : value;
        break;
      case "status-color":
        action.statusColor = value === "" ? null : parseColorSpec(value);
        break;
    }
  }
  return action;
}

function* extractTabPairs(data: string): Generator<[string, string]> {
  let key = "";
  let val = "";
  let inVal = false;
  let esc = false;
  for (const c of data) {
    if (esc) {
      if (inVal) val += c;
      else key += c;
      esc = false;
    } else if (c === "\\") {
      esc = true;
    } else if (c === ";") {
      yield [key, val];
      key = "";
      val = "";
      inVal = false;
    } else if (c === "=" && !inVal) {
      inVal = true;
    } else if (inVal) {
      val += c;
    } else {
      key += c;
    }
  }
  if (key || inVal) yield [key, val];
}

export function link(url: string, params?: Record<string, string>): string {
  if (!url) return HYPERLINK_END;
  const p = { id: generateHyperlinkId(url), ...params };
  const paramStr = Object.entries(p)
    .map(([k, v]) => `${k}=${v}`)
    .join(":");
  return osc(OSC.HYPERLINK, paramStr, url);
}

function generateHyperlinkId(url: string): string {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = ((h << 5) - h + url.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export const HYPERLINK_END = osc(OSC.HYPERLINK, "", "");

export const ITERM2_COMMANDS = {
  NOTIFY: 0,
  BADGE: 2,
  PROGRESS_STATES: 4,
} as const;

export const PROGRESS_STATES = {
  CLEAR: 0,
  SET: 1,
  ERROR: 2,
  INDETERMINATE: 3,
} as const;

export const ITERM2_PROGRESS_CLEAR = `${SEQUENCE_PREFIX}${OSC.ITERM2_COMMANDS};${ITERM2_COMMANDS.PROGRESS_STATES};${PROGRESS_STATES.CLEAR};${BEL}`;

export const TERMINAL_TITLE_CLEAR = `${SEQUENCE_PREFIX}${OSC.SET_TITLE_AND_ICON};${BEL}`;

export const TAB_STATUS_CLEAR = osc(OSC.TAB_STATUS, "indicator=;status=;status-color=");

export function hasTabStatusSupport(): boolean {
  return false;
}

export function encodeTabStatus(fields: TabStatusAction): string {
  const parts: string[] = [];
  const rgb = (c: Color) =>
    c.type === "rgb"
      ? `#${[c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, "0")).join("")}`
      : "";
  if ("indicator" in fields)
    parts.push(`indicator=${fields.indicator ? rgb(fields.indicator) : ""}`);
  if ("status" in fields)
    parts.push(`status=${fields.status?.replaceAll("\\", "\\\\").replaceAll(";", "\\;") ?? ""}`);
  if ("statusColor" in fields)
    parts.push(`status-color=${fields.statusColor ? rgb(fields.statusColor) : ""}`);
  return osc(OSC.TAB_STATUS, parts.join(";"));
}
