import type { Action } from "@/terminal-runtime/terminal/protocol-contracts.js";

export function decodeTermSeq(chars: string): Action | null {
  if (chars.length === 0) return null;

  const first = chars[0]!;

  if (first === "c") {
    return { type: "reset" };
  }

  if (first === "7") {
    return { type: "cursor", action: { type: "save" } };
  }

  if (first === "8") {
    return { type: "cursor", action: { type: "restore" } };
  }

  if (first === "D") {
    return {
      type: "cursor",
      action: { type: "move", direction: "down", count: 1 },
    };
  }

  if (first === "M") {
    return {
      type: "cursor",
      action: { type: "move", direction: "up", count: 1 },
    };
  }

  if (first === "E") {
    return { type: "cursor", action: { type: "nextLine", count: 1 } };
  }

  if (first === "H") {
    return null;
  }

  if ("()".includes(first) && chars.length >= 2) {
    return null;
  }

  return { type: "unknown", sequence: `\x1b${chars}` };
}
