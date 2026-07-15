let cachedJetBrainsTerminalName: string | null | undefined;

async function resolveJetBrainsTerminalName(): Promise<string | null> {
  if (cachedJetBrainsTerminalName !== undefined) return cachedJetBrainsTerminalName;
  cachedJetBrainsTerminalName = null;
  return cachedJetBrainsTerminalName;
}

export class TerminalDetector {
  private readonly proc: NodeJS.Process;

  constructor(proc: NodeJS.Process = process) {
    this.proc = proc;
  }

  isJetBrainsIdeTerminal(): boolean {
    return this.proc.env.TERMINAL_EMULATOR === "JetBrains-JediTerm";
  }

  isMicrosoftWindowsTerminal(): boolean {
    return this.proc.platform === "win32" && !!this.proc.env.WT_SESSION;
  }

  isWslWithUnrecognizedWindowsHost(): boolean {
    const env = this.proc.env;
    if (this.proc.platform !== "linux" || !(env.WSL_DISTRO_NAME || env.WSL_INTEROP)) {
      return false;
    }
    return !(
      env.WT_SESSION ||
      env.TERM_PROGRAM ||
      env.TERMINAL_EMULATOR ||
      env.ConEmuPID ||
      env.ALACRITTY_WINDOW_ID ||
      env.SSH_CONNECTION ||
      env.TMUX ||
      env.STY
    );
  }

  isGhostty(): boolean {
    return this.proc.env.TERM === "xterm-ghostty" || this.proc.env.TERM_PROGRAM === "ghostty";
  }

  detectMinttyShell(): boolean {
    if (this.proc.env.TERM_PROGRAM === "mintty") return true;
    if (this.proc.platform === "win32" && this.proc.env.MSYSTEM) return true;
    return false;
  }

  windowsConsoleSupportsVirtualTerminalSequences(): boolean {
    if (this.isMicrosoftWindowsTerminal()) return true;
    if (
      this.proc.platform === "win32" &&
      this.proc.env.TERM_PROGRAM === "vscode" &&
      this.proc.env.TERM_PROGRAM_VERSION
    ) {
      return true;
    }
    if (this.detectMinttyShell()) return true;
    return false;
  }

  hasGeometricShapesInkBleedBug(): boolean {
    return this.isGhostty();
  }

  async getTerminalName(): Promise<string | undefined> {
    if (this.isJetBrainsIdeTerminal()) {
      if (this.proc.platform !== "darwin") {
        return (await resolveJetBrainsTerminalName()) ?? "pycharm";
      }
    }
    return this.proc.env.TERM_PROGRAM;
  }

  getTerminalNameSync(): string | undefined {
    if (this.isJetBrainsIdeTerminal()) {
      if (this.proc.platform !== "darwin") {
        if (cachedJetBrainsTerminalName !== undefined) {
          return cachedJetBrainsTerminalName ?? "pycharm";
        }
        return "pycharm";
      }
    }
    return this.proc.env.TERM_PROGRAM;
  }

  async warmTerminalName(): Promise<void> {
    if (this.isJetBrainsIdeTerminal()) await resolveJetBrainsTerminalName();
  }
}

export const terminalDetector = new TerminalDetector();
