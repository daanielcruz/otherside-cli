import { loadSessionForResume } from "@/engine/session/index.ts";
import type { CliMode } from "@/modes/args.ts";
import { sgr } from "@/terminal-runtime";

const ANSI_RED = sgr(31);
const ANSI_FOREGROUND_RESET = sgr(39);

export function formatDirectResumeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${ANSI_RED}${message}${ANSI_FOREGROUND_RESET}\n`;
}

export interface StartupResume {
  effectiveResumeId: string | null;
  resumeLoad: Awaited<ReturnType<typeof loadSessionForResume>>;
}

/**
 * Resolves which session (if any) this launch resumes and loads it. A failure
 * exits directly: nothing interactive has mounted, so waiting on in-flight
 * startup work (MCP refresh, hooks) would only hold the event loop open.
 */
export async function resolveStartupResume(
  mode: Extract<CliMode, { kind: "interactive" } | { kind: "print" }>,
): Promise<StartupResume> {
  let effectiveResumeId: string | null = null;
  if (mode.resumeSessionId) {
    // The flag takes an id or a title the user gave the session; the lookup only
    // runs for a value that names no session file, so resuming by id reads nothing
    // it would not have read anyway.
    const { resolveSessionRef } = await import("@/engine/session/title/resolve.ts");
    try {
      effectiveResumeId = await resolveSessionRef(mode.resumeSessionId, process.cwd());
    } catch (error) {
      process.stderr.write(formatDirectResumeError(error));
      process.exit(1);
    }
  } else if (mode.resumeLatest) {
    const { latestSessionId } = await import("@/engine/session/paths.ts");
    effectiveResumeId = latestSessionId(process.cwd());
    if (effectiveResumeId === null) {
      process.stderr.write(formatDirectResumeError(new Error("No conversation found to continue")));
      process.exit(1);
    }
  }
  try {
    const resumeLoad = effectiveResumeId
      ? await loadSessionForResume(effectiveResumeId)
      : {
          records: [],
          modelRecords: [],
          usageRecords: [],
          chainHead: null,
          cwd: null,
          tailRecords: [],
          recordsArePartial: false,
        };
    return { effectiveResumeId, resumeLoad };
  } catch (error) {
    process.stderr.write(formatDirectResumeError(error));
    process.exit(1);
  }
}
