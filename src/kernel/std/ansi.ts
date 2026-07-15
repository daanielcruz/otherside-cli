const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const SGR_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const OSC8_RE = new RegExp(`${ESC}]8;;.*?(?:${BEL}|${ESC}\\\\)`, "g");

export function stripAnsi(value: string): string {
  return value.replace(OSC8_RE, "").replace(SGR_RE, "");
}
