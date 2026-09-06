import { createSupportsHyperlinks } from "supports-hyperlinks";
import { readAttacherCapabilities } from "@/terminal-runtime/host/environment.js";

type EnvironmentTable = Record<string, string | undefined>;

type LinkProbeOptions = {
  env?: EnvironmentTable;
  libraryDecision?: boolean;
};

const LINK_AWARE_PROGRAMS = new Set([
  "ghostty",
  "Hyper",
  "kitty",
  "alacritty",
  "iTerm.app",
  "iTerm2",
  "WezTerm",
  "vscode",
]);

function muxPassesLinks(env: EnvironmentTable): boolean {
  if (env.TERM_PROGRAM !== "tmux") return false;
  const parts = (env.TERM_PROGRAM_VERSION ?? "").split(".");
  const major = Number.parseInt(parts[0] ?? "", 10);
  const minor = Number.parseInt(parts[1] ?? "", 10);
  return major > 3 || (major === 3 && minor >= 4);
}

function environmentAdvertisesLinks(env: EnvironmentTable): boolean {
  const program = env.TERM_PROGRAM;
  const inheritedProgram = env.LC_TERMINAL;
  const terminalType = env.TERM ?? "";
  return [
    program !== undefined && LINK_AWARE_PROGRAMS.has(program),
    inheritedProgram !== undefined && LINK_AWARE_PROGRAMS.has(inheritedProgram),
    env.TERMINAL_EMULATOR === "JetBrains-JediTerm",
    muxPassesLinks(env),
    terminalType.includes("kitty"),
    terminalType.includes("ghostty"),
  ].some(Boolean);
}

export function evaluateLinkSupport(options?: LinkProbeOptions): boolean {
  const environment = options?.env ?? process.env;
  const remoteDecision = readAttacherCapabilities()?.hyperlinks;
  if (remoteDecision !== undefined) return remoteDecision;

  const libraryDecision = options?.libraryDecision ?? createSupportsHyperlinks(process.stdout);
  if ("FORCE_HYPERLINK" in environment) return libraryDecision;
  return libraryDecision || environmentAdvertisesLinks(environment);
}

export function terminalAllowsLinks(): boolean {
  if (process.env.NO_HYPERLINK || process.env.FORCE_HYPERLINK === "0") return false;
  if (process.env.FORCE_HYPERLINK === "1") return true;
  return evaluateLinkSupport();
}
