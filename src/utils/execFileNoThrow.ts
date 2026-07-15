import { type ExecaError, execa } from "execa";
import { writeDebugError } from "@/devtools/output.ts";

const MS_IN_SECOND = 1000;
const SECONDS_IN_MINUTE = 60;

type ProcessRunConfig = {
  abortSignal?: AbortSignal;
  timeout?: number;
  preserveOutputOnError?: boolean;

  useCwd?: boolean;
  env?: NodeJS.ProcessEnv;
  stdin?: "ignore" | "inherit" | "pipe";
  input?: string;
};

export function runProcessSafely(
  file: string,
  args: string[],
  options: ProcessRunConfig = {
    timeout: 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    preserveOutputOnError: true,
    useCwd: true,
  },
): Promise<{ stdout: string; stderr: string; code: number; error?: string }> {
  return runProcessSafelyFromDir(file, args, {
    abortSignal: options.abortSignal,
    timeout: options.timeout,
    preserveOutputOnError: options.preserveOutputOnError,
    cwd: options.useCwd ? process.cwd() : undefined,
    env: options.env,
    stdin: options.stdin,
    input: options.input,
  });
}

type ProcessRunConfigWithDir = {
  abortSignal?: AbortSignal | undefined;
  timeout?: number | undefined;
  preserveOutputOnError?: boolean | undefined;
  maxBuffer?: number | undefined;
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  shell?: boolean | string | undefined;
  stdin?: "ignore" | "inherit" | "pipe" | undefined;
  input?: string | undefined;
};

type ProcessResultWithErrorInfo = {
  shortMessage?: string;
  signal?: string;
};

function extractErrorDescription(result: ProcessResultWithErrorInfo, errorCode: number): string {
  if (result.shortMessage) {
    return result.shortMessage;
  }
  if (typeof result.signal === "string") {
    return result.signal;
  }
  return String(errorCode);
}

export function runProcessSafelyFromDir(
  file: string,
  args: string[],
  {
    abortSignal,
    timeout: finalTimeout = 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    preserveOutputOnError: finalPreserveOutput = true,
    cwd: finalCwd,
    env: finalEnv,
    maxBuffer,
    shell,
    stdin: finalStdin,
    input: finalInput,
  }: ProcessRunConfigWithDir = {
    timeout: 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    preserveOutputOnError: true,
    maxBuffer: 1_000_000,
  },
): Promise<{ stdout: string; stderr: string; code: number; error?: string }> {
  return new Promise((resolve) => {
    execa(file, args, {
      timeout: finalTimeout,
      reject: false,
      ...(maxBuffer !== undefined ? { maxBuffer } : {}),
      ...(abortSignal !== undefined ? { cancelSignal: abortSignal } : {}),
      ...(finalCwd !== undefined ? { cwd: finalCwd } : {}),
      ...(finalEnv !== undefined ? { env: finalEnv } : {}),
      ...(shell !== undefined ? { shell } : {}),
      ...(finalStdin !== undefined ? { stdin: finalStdin } : {}),
      ...(finalInput !== undefined ? { input: finalInput } : {}),
    })
      .then((result) => {
        const stdoutStr = String(result.stdout ?? "");
        const stderrStr = String(result.stderr ?? "");
        if (result.failed) {
          if (finalPreserveOutput) {
            const errorCode = result.exitCode ?? 1;
            void resolve({
              stdout: stdoutStr,
              stderr: stderrStr,
              code: errorCode,
              error: extractErrorDescription(
                result as unknown as ProcessResultWithErrorInfo,
                errorCode,
              ),
            });
          } else {
            void resolve({ stdout: "", stderr: "", code: result.exitCode ?? 1 });
          }
        } else {
          void resolve({
            stdout: stdoutStr,
            stderr: stderrStr,
            code: 0,
          });
        }
      })
      .catch((error: ExecaError) => {
        writeDebugError(error);
        void resolve({ stdout: "", stderr: "", code: 1 });
      });
  });
}
