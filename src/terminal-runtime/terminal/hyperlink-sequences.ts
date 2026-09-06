import { pathToFileURL } from "node:url";
import {
  OSC,
  oscWithStringTerminator,
} from "@/terminal-runtime/terminal/operating-system-command.js";

const LAST_PRINTABLE_CONTROL = 0x1f;
const DELETE_CODE = 0x7f;

function stripControlBytes(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= LAST_PRINTABLE_CONTROL || code === DELETE_CODE) continue;
    out += ch;
  }
  return out;
}

export function fileUrlForPath(path: string): string | null {
  try {
    return pathToFileURL(path).href;
  } catch {
    return null;
  }
}

export function osc8FileLink(options: { path: string; label: string }): string {
  const url = fileUrlForPath(options.path);
  if (url === null) return stripControlBytes(options.label);
  return osc8Link(url, options.label);
}

export function osc8UrlLink(options: { url: string; label: string }): string {
  return osc8Link(options.url, options.label);
}

function osc8Link(url: string, label: string): string {
  const open = oscWithStringTerminator(OSC.HYPERLINK, "", url);
  const close = oscWithStringTerminator(OSC.HYPERLINK, "", "");
  return open + stripControlBytes(label) + close;
}
