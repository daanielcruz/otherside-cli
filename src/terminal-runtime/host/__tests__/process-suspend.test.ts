import { describe, expect, it } from "bun:test";
import { type SuspendSignals, suspendToShell } from "@/terminal-runtime/host/process-suspend.ts";

function recordingSignals(log: string[]): SuspendSignals & { resume: () => void } {
  let resumeHandler: (() => void) | null = null;
  return {
    raise: (signal) => log.push(`raise:${signal}`),
    onceResumed: (handler) => {
      log.push("listen:resume");
      resumeHandler = handler;
    },
    resume: () => resumeHandler?.(),
  };
}

describe("suspendToShell", () => {
  it("listens for the resume before releasing, and stops the process last", () => {
    const log: string[] = [];
    const signals = recordingSignals(log);

    suspendToShell(
      { release: () => log.push("release"), reclaim: () => log.push("reclaim") },
      signals,
    );

    expect(log).toEqual(["listen:resume", "release", "raise:SIGTSTP"]);
  });

  it("reclaims the terminal when the shell foregrounds the process again", () => {
    const log: string[] = [];
    const signals = recordingSignals(log);

    suspendToShell(
      { release: () => log.push("release"), reclaim: () => log.push("reclaim") },
      signals,
    );
    signals.resume();

    expect(log.at(-1)).toBe("reclaim");
  });
});
