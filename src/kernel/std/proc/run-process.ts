import { execa } from "execa";
import { writeDebugError } from "@/devtools/output.ts";

const DEFAULT_PROCESS_TIMEOUT_MS = 600_000;

type ProcessInputMode = "ignore" | "inherit" | "pipe";

export type RunProcessOptions = {
  abortSignal?: AbortSignal;
  timeout?: number;
  preserveOutputOnError?: boolean;
  useCwd?: boolean;
  env?: NodeJS.ProcessEnv;
  stdin?: ProcessInputMode;
  input?: string;
};

export type RunProcessAtOptions = {
  abortSignal?: AbortSignal | undefined;
  timeout?: number | undefined;
  preserveOutputOnError?: boolean | undefined;
  maxBuffer?: number | undefined;
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  shell?: boolean | string | undefined;
  stdin?: ProcessInputMode | undefined;
  input?: string | undefined;
};

export type ProcessRunResult = {
  stdout: string;
  stderr: string;
  code: number;
  error?: string;
};

type FailedProcessDetails = {
  shortMessage?: string;
  signal?: string;
};

function summarizeProcessFailure(details: FailedProcessDetails, code: number): string {
  if (details.shortMessage) return details.shortMessage;
  if (typeof details.signal === "string") return details.signal;
  return String(code);
}

export function runProcessSafely(
  executable: string,
  argv: string[],
  options: RunProcessOptions = {
    timeout: DEFAULT_PROCESS_TIMEOUT_MS,
    preserveOutputOnError: true,
    useCwd: true,
  },
): Promise<ProcessRunResult> {
  return runProcessSafelyFromDir(executable, argv, {
    timeout: options.timeout,
    cwd: options.useCwd ? process.cwd() : undefined,
    input: options.input,
    stdin: options.stdin,
    env: options.env,
    preserveOutputOnError: options.preserveOutputOnError,
    abortSignal: options.abortSignal,
  });
}

export async function runProcessSafelyFromDir(
  executable: string,
  argv: string[],
  options: RunProcessAtOptions = {
    timeout: DEFAULT_PROCESS_TIMEOUT_MS,
    preserveOutputOnError: true,
    maxBuffer: 1_000_000,
  },
): Promise<ProcessRunResult> {
  const {
    abortSignal,
    timeout = DEFAULT_PROCESS_TIMEOUT_MS,
    preserveOutputOnError = true,
    maxBuffer,
    cwd,
    env,
    shell,
    stdin,
    input,
  } = options;

  try {
    const completed = await execa(executable, argv, {
      timeout,
      reject: false,
      ...(maxBuffer === undefined ? {} : { maxBuffer }),
      ...(abortSignal === undefined ? {} : { cancelSignal: abortSignal }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(env === undefined ? {} : { env }),
      ...(shell === undefined ? {} : { shell }),
      ...(stdin === undefined ? {} : { stdin }),
      ...(input === undefined ? {} : { input }),
    });
    const stdout = String(completed.stdout ?? "");
    const stderr = String(completed.stderr ?? "");

    if (!completed.failed) return { stdout, stderr, code: 0 };

    const code = completed.exitCode ?? 1;
    if (!preserveOutputOnError) return { stdout: "", stderr: "", code };

    return {
      stdout,
      stderr,
      code,
      error: summarizeProcessFailure(completed as FailedProcessDetails, code),
    };
  } catch (error) {
    writeDebugError(error);
    return { stdout: "", stderr: "", code: 1 };
  }
}
