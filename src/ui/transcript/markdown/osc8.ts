import { pathToFileURL } from "node:url";

const OSC = `${String.fromCharCode(27)}]8;;`;
const ST = `${String.fromCharCode(27)}\\`;
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

function fileUrlForPath(path: string): string | null {
  try {
    return pathToFileURL(path).href;
  } catch {
    return null;
  }
}

export function osc8FileLink(options: { path: string; label: string }): string {
  const safeLabel = stripControlBytes(options.label);
  const url = fileUrlForPath(options.path);
  if (url === null) return safeLabel;
  return `${OSC}${url}${ST}${safeLabel}${OSC}${ST}`;
}

export function osc8UrlLink(options: { url: string; label: string }): string {
  const safeLabel = stripControlBytes(options.label);
  return `${OSC}${options.url}${ST}${safeLabel}${OSC}${ST}`;
}
