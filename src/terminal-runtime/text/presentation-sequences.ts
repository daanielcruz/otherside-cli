import { BEL, ESC } from "@/terminal-runtime/terminal/ansi-control.js";

const STRING_TERMINATOR = `${ESC}\\`;
const SGR_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const OSC8_RE = new RegExp(`${ESC}]8;;.*?(?:${BEL}|${ESC}\\\\)`, "g");

export function stripAnsi(value: string): string {
  return value.replace(OSC8_RE, "").replace(SGR_RE, "");
}

export function readPresentationSequence(
  text: string,
  index: number,
): { value: string; next: number } | null {
  if (text[index] !== ESC) return null;

  if (text[index + 1] === "[") {
    const end = text.indexOf("m", index + 2);
    return end === -1 ? null : { value: text.slice(index, end + 1), next: end + 1 };
  }

  if (text[index + 1] !== "]") return null;
  const bellIndex = text.indexOf(BEL, index + 2);
  const stringTerminatorIndex = text.indexOf(STRING_TERMINATOR, index + 2);
  const ends = [
    bellIndex === -1 ? undefined : bellIndex + 1,
    stringTerminatorIndex === -1 ? undefined : stringTerminatorIndex + STRING_TERMINATOR.length,
  ].filter((end): end is number => end !== undefined);
  if (ends.length === 0) return null;
  const next = Math.min(...ends);
  return { value: text.slice(index, next), next };
}
