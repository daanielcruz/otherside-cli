import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type DevtoolSettingName, devtoolBoolean, devtoolPath } from "@/devtools/settings.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";

export type DiagnosticStream =
  | "repaints"
  | "frame-timing"
  | "commit-log"
  | "prompt-cache"
  | "stream-close"
  | "wire"
  | "shell"
  | "stall-watchdog";

const BOOLEAN_SETTINGS: Record<Exclude<DiagnosticStream, "commit-log">, DevtoolSettingName> = {
  repaints: "repaintDiagnostics",
  "frame-timing": "frameTiming",
  "prompt-cache": "promptCacheDiagnostics",
  "stream-close": "streamCloseDiagnostics",
  wire: "wireDiagnostics",
  shell: "shellDiagnostics",
  "stall-watchdog": "stallDiagnostics",
};

export function isStreamEnabled(stream: DiagnosticStream): boolean {
  if (stream === "commit-log") return devtoolPath("commitLog") !== undefined;
  return devtoolBoolean(BOOLEAN_SETTINGS[stream]);
}

export interface DiagnosticPathOptions {
  readonly stream: DiagnosticStream;
  readonly sessionId?: string;
  readonly suffix?: string;
}

export function diagnosticPath(options: DiagnosticPathOptions): string {
  const root = devtoolPath("debugLogDir") ?? join(configRoot(), "debug");
  const session = options.sessionId ?? "global";
  const filename =
    options.suffix === undefined
      ? `${options.stream}.jsonl`
      : `${options.stream}.${options.suffix}.jsonl`;
  return join(root, session, filename);
}

export function writeDiagnostic(path: string, payload: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  } catch {}
}

export function appendDiagnosticLine(path: string, line: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line.endsWith("\n") ? line : `${line}\n`, {
      mode: 0o600,
    });
  } catch {}
}
