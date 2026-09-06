import { afterEach, describe, expect, it } from "bun:test";

const trackedEnvironment = [
  "OTHERSIDE_BACKGROUND_BACKEND",
  "OTHERSIDE_FORCE_SYNC_OUTPUT",
  "TMUX",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM",
  "TERMINAL_EMULATOR",
  "KONSOLE_VERSION",
  "KITTY_WINDOW_ID",
  "ZED_TERM",
  "WT_SESSION",
  "VTE_VERSION",
  "ConEmuANSI",
  "ConEmuPID",
  "ConEmuTask",
] as const;
const originalEnvironment = Object.fromEntries(
  trackedEnvironment.map((name) => [name, process.env[name]]),
);
const originalIsTTY = process.stdout.isTTY;

function resetEnvironment(): void {
  for (const name of trackedEnvironment) delete process.env[name];
}

async function loadPolicy() {
  return import(`@/terminal-runtime/terminal/capability-policy.js?test=${crypto.randomUUID()}`);
}

function setStdoutTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

afterEach(() => {
  resetEnvironment();
  for (const name of trackedEnvironment) {
    const value = originalEnvironment[name];
    if (value !== undefined) process.env[name] = value;
  }
  setStdoutTTY(Boolean(originalIsTTY));
});

describe("terminal capability policy", () => {
  it("requires a TTY for progress reporting", async () => {
    resetEnvironment();
    setStdoutTTY(false);
    process.env.TERM_PROGRAM = "ghostty";
    process.env.TERM_PROGRAM_VERSION = "1.2.0";
    expect((await loadPolicy()).canReportRenderMetrics()).toBe(false);
  });

  it("excludes Windows Terminal progress sequences", async () => {
    resetEnvironment();
    setStdoutTTY(true);
    process.env.WT_SESSION = "1";
    process.env.ConEmuANSI = "ON";
    expect((await loadPolicy()).canReportRenderMetrics()).toBe(false);
  });

  it.each(["ConEmuANSI", "ConEmuPID", "ConEmuTask"])("allows progress through %s", async (name) => {
    resetEnvironment();
    setStdoutTTY(true);
    process.env[name] = "1";
    expect((await loadPolicy()).canReportRenderMetrics()).toBe(true);
  });

  it.each([
    ["ghostty", "1.1.9", false],
    ["ghostty", "1.2.0", true],
    ["iTerm.app", "3.6.5", false],
    ["iTerm.app", "3.6.6", true],
    ["WezTerm", "20240203", false],
  ])("checks progress support for %s %s", async (program, version, expected) => {
    resetEnvironment();
    setStdoutTTY(true);
    process.env.TERM_PROGRAM = program;
    process.env.TERM_PROGRAM_VERSION = version;
    expect((await loadPolicy()).canReportRenderMetrics()).toBe(expected);
  });

  it("uses daemon attacher fallback policy", async () => {
    resetEnvironment();
    process.env.OTHERSIDE_BACKGROUND_BACKEND = "daemon";
    expect((await loadPolicy()).canUseSyncOutput()).toBe(true);
  });

  it("lets an explicit force override the conservative tmux default", async () => {
    resetEnvironment();
    process.env.TMUX = "1";
    process.env.OTHERSIDE_FORCE_SYNC_OUTPUT = "1";
    process.env.TERM_PROGRAM = "iTerm.app";
    expect((await loadPolicy()).canUseSyncOutput()).toBe(true);
  });

  it("disables sync output under tmux without an explicit override", async () => {
    resetEnvironment();
    process.env.TMUX = "1";
    process.env.TERM_PROGRAM = "iTerm.app";
    expect((await loadPolicy()).canUseSyncOutput()).toBe(false);
  });

  it.each(["1", "true", "yes", "on"])("honors force sync value %s", async (value) => {
    resetEnvironment();
    process.env.OTHERSIDE_FORCE_SYNC_OUTPUT = value;
    expect((await loadPolicy()).canUseSyncOutput()).toBe(true);
  });

  it.each([
    ["TERM_PROGRAM", "iTerm.app"],
    ["TERM_PROGRAM", "WezTerm"],
    ["TERM_PROGRAM", "WarpTerminal"],
    ["TERM_PROGRAM", "ghostty"],
    ["TERM_PROGRAM", "contour"],
    ["TERM_PROGRAM", "vscode"],
    ["TERM_PROGRAM", "alacritty"],
    ["TERM_PROGRAM", "mintty"],
    ["TERM_PROGRAM", "rio"],
    ["TERM_PROGRAM", "Tabby"],
    ["TERMINAL_EMULATOR", "JetBrains-JediTerm"],
    ["KONSOLE_VERSION", "211200"],
    ["TERM", "xterm-kitty"],
    ["KITTY_WINDOW_ID", "1"],
    ["TERM", "xterm-ghostty"],
    ["TERM", "foot-extra"],
    ["TERM", "xterm-alacritty"],
    ["ZED_TERM", "1"],
    ["WT_SESSION", "1"],
    ["VTE_VERSION", "6800"],
  ])("allows sync output for %s=%s", async (name, value) => {
    resetEnvironment();
    process.env[name] = value;
    expect((await loadPolicy()).canUseSyncOutput()).toBe(true);
  });

  it.each([
    ["KONSOLE_VERSION", "211199"],
    ["VTE_VERSION", "6799"],
    ["TERM_PROGRAM", "Apple_Terminal"],
    ["TERM", "xterm-256color"],
  ])("rejects sync output for %s=%s", async (name, value) => {
    resetEnvironment();
    process.env[name] = value;
    expect((await loadPolicy()).canUseSyncOutput()).toBe(false);
  });

  it.each([
    "iTerm.app",
    "kitty",
    "WezTerm",
    "ghostty",
    "tmux",
    "windows-terminal",
    "WarpTerminal",
  ])("allows advanced input in %s", async (terminal) =>
    expect((await loadPolicy()).supportsAdvancedInput(terminal)).toBe(true));

  it.each(["", "vscode", "Apple_Terminal"])("rejects advanced input in %p", async (terminal) => {
    expect((await loadPolicy()).supportsAdvancedInput(terminal)).toBe(false);
  });

  it("detects web terminal names and keeps the first XTVERSION name", async () => {
    resetEnvironment();
    const policy = await loadPolicy();
    expect(policy.isWebTerminalEngine()).toBe(false);
    policy.setDetectedTerminalVersion("xterm.js 5.3.0");
    policy.setDetectedTerminalVersion("Ghostty 1.2.0");
    expect(policy.readDetectedTerminalVersion()).toBe("xterm.js 5.3.0");
    expect(policy.isWebTerminalEngine()).toBe(true);
  });

  it("detects vscode from TERM_PROGRAM", async () => {
    resetEnvironment();
    process.env.TERM_PROGRAM = "vscode";
    expect((await loadPolicy()).isWebTerminalEngine()).toBe(true);
  });

  it("detects the cursor-line bug from Windows Terminal", async () => {
    resetEnvironment();
    process.env.WT_SESSION = "1";
    expect((await loadPolicy()).hasCursorLineManipulationBug()).toBe(true);
  });

  it("captures eager sync capability at module load", async () => {
    resetEnvironment();
    process.env.TERM_PROGRAM = "iTerm.app";
    const policy = await loadPolicy();
    delete process.env.TERM_PROGRAM;
    expect(policy.SYNC_OUTPUT_CAPABLE).toBe(true);
    expect(policy.canUseSyncOutput()).toBe(false);
  });
});
