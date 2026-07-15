import { type ChildProcess, spawn } from "node:child_process";
import { getSessionSuffix } from "./macos.ts";

export interface SandboxViolation {
  line: string;
  command?: string;
  encodedCommand?: string;
  timestamp: Date;
}

const CMD_EXTRACT_RE = /CMD64_(.+?)_END/;
const SANDBOX_EXTRACT_RE = /Sandbox:\s+(.+)$/;

const NOISE_SUBSTRINGS = [
  "mDNSResponder",
  "mach-lookup com.apple.diagnosticd",
  "mach-lookup com.apple.analyticsd",
];

const violationsByLogTag = new Map<string, SandboxViolation[]>();
let monitorProcess: ChildProcess | null = null;
let monitorStarted = false;
let ignoreViolations: Record<string, string[]> | undefined;

function shouldIgnore(violationDetails: string, command: string | undefined): boolean {
  if (!ignoreViolations) return false;
  const wildcardPaths = ignoreViolations["*"] ?? [];
  for (const path of wildcardPaths) {
    if (violationDetails.includes(path)) return true;
  }
  if (!command) return false;
  for (const [pattern, paths] of Object.entries(ignoreViolations)) {
    if (pattern === "*") continue;
    if (!command.includes(pattern)) continue;
    for (const path of paths) {
      if (violationDetails.includes(path)) return true;
    }
  }
  return false;
}

export function __setIgnoreViolationsForTests(map: Record<string, string[]> | undefined): void {
  ignoreViolations = map;
}

export function __clearViolationsForTests(): void {
  violationsByLogTag.clear();
}

export function handleStreamLine(buffer: string): void {
  const lines = buffer.split("\n");
  let violationLine: string | undefined;
  let commandLine: string | undefined;
  let logTagLine: string | undefined;
  for (const line of lines) {
    if (line.includes("Sandbox:") && line.includes("deny")) violationLine = line;
    if (line.startsWith("CMD64_")) commandLine = line;
    const tagMatch = line.match(/CMD64_[A-Za-z0-9+/=]+_END__[a-z0-9]+_SBX/);
    if (tagMatch) logTagLine = tagMatch[0];
  }
  if (!violationLine) return;
  const sandboxMatch = violationLine.match(SANDBOX_EXTRACT_RE);
  const violationDetails = sandboxMatch?.[1];
  if (!violationDetails) return;
  for (const noise of NOISE_SUBSTRINGS) {
    if (violationDetails.includes(noise)) return;
  }
  let command: string | undefined;
  let encodedCommand: string | undefined;
  if (commandLine) {
    const cmdMatch = commandLine.match(CMD_EXTRACT_RE);
    encodedCommand = cmdMatch?.[1];
    if (encodedCommand) {
      try {
        command = Buffer.from(encodedCommand, "base64").toString("utf8");
      } catch {}
    }
  }
  if (shouldIgnore(violationDetails, command)) return;
  const violation: SandboxViolation = {
    line: violationDetails,
    timestamp: new Date(),
    ...(command ? { command } : {}),
    ...(encodedCommand ? { encodedCommand } : {}),
  };
  if (logTagLine) {
    const list = violationsByLogTag.get(logTagLine) ?? [];
    list.push(violation);
    violationsByLogTag.set(logTagLine, list);
  }
}

export function startSandboxMonitor(opts?: { ignoreViolations?: Record<string, string[]> }): void {
  if (monitorStarted) return;
  if (process.platform !== "darwin") return;
  monitorStarted = true;
  ignoreViolations = opts?.ignoreViolations;
  const suffix = getSessionSuffix();
  try {
    monitorProcess = spawn(
      "/usr/bin/log",
      ["stream", "--predicate", `(eventMessage ENDSWITH "${suffix}")`, "--style", "compact"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    monitorStarted = false;
    return;
  }
  let buffer = "";
  monitorProcess.stdout?.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lastNewline = buffer.lastIndexOf("\n");
    if (lastNewline === -1) return;
    handleStreamLine(buffer.slice(0, lastNewline));
    buffer = buffer.slice(lastNewline + 1);
  });
  monitorProcess.on("exit", () => {
    monitorStarted = false;
    monitorProcess = null;
  });
  process.on("exit", () => {
    if (monitorProcess) {
      try {
        monitorProcess.kill("SIGTERM");
      } catch {}
    }
  });
}

export function takeViolationsForLogTag(logTag: string): SandboxViolation[] {
  const list = violationsByLogTag.get(logTag) ?? [];
  violationsByLogTag.delete(logTag);
  return list;
}

export function stopSandboxMonitor(): void {
  if (monitorProcess) {
    try {
      monitorProcess.kill("SIGTERM");
    } catch {}
    monitorProcess = null;
  }
  monitorStarted = false;
  violationsByLogTag.clear();
}
