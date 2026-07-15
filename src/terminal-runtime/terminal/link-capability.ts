import { useSyncExternalStore } from "react";
import { createSupportsHyperlinks } from "supports-hyperlinks";
import { getAttacherCaps, onAttacherCapsChange } from "@/bootstrap/state.js";

export const RECOGNIZED_HYPERLINK_TERMINALS = [
  "ghostty",
  "Hyper",
  "kitty",
  "alacritty",
  "iTerm.app",
  "iTerm2",
  "WezTerm",
  "vscode",
];

type EnvLike = Record<string, string | undefined>;

type HyperlinkCompatibilityOptions = {
  env?: EnvLike;
  stdoutSupported?: boolean;
};

export function detectHyperlinkCapability(options?: HyperlinkCompatibilityOptions): boolean {
  const env = options?.env ?? process.env;

  const attacherHyperlinks = getAttacherCaps()?.hyperlinks;
  if (attacherHyperlinks !== undefined) {
    return attacherHyperlinks;
  }

  const stdoutSupported = options?.stdoutSupported ?? createSupportsHyperlinks(process.stdout);

  if ("FORCE_HYPERLINK" in env) {
    return stdoutSupported;
  }
  if (stdoutSupported) {
    return true;
  }

  const termProgram = env.TERM_PROGRAM;
  if (termProgram && RECOGNIZED_HYPERLINK_TERMINALS.includes(termProgram)) {
    return true;
  }

  if (env.TERMINAL_EMULATOR === "JetBrains-JediTerm") {
    return true;
  }

  if (termProgram === "tmux") {
    const [major, minor] = (env.TERM_PROGRAM_VERSION ?? "").split(".");
    const majorNum = parseInt(major ?? "", 10);
    const minorNum = parseInt(minor ?? "", 10);
    if (majorNum > 3 || (majorNum === 3 && minorNum >= 4)) {
      return true;
    }
  }

  const lcTerminal = env.LC_TERMINAL;
  if (lcTerminal && RECOGNIZED_HYPERLINK_TERMINALS.includes(lcTerminal)) {
    return true;
  }

  const term = env.TERM;
  if (term?.includes("kitty") || term?.includes("ghostty")) {
    return true;
  }

  return false;
}

export function useSupportsHyperlinks(): boolean {
  return useSyncExternalStore(onAttacherCapsChange, detectHyperlinkCapability);
}
