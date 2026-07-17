import { expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { runForeground } from "../foreground.ts";

const isWindows = process.platform === "win32";

function uniqueMarker(): string {
  return `otherside-foreground-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function matchingPids(marker: string): number[] {
  if (process.platform === "linux") {
    return readdirSync("/proc").flatMap((entry) => {
      if (!/^\d+$/.test(entry)) return [];
      try {
        return readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(marker)
          ? [Number(entry)]
          : [];
      } catch {
        return [];
      }
    });
  }

  const result = Bun.spawnSync(["ps", "ax", "-o", "pid=", "-o", "command="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return [];
  return result.stdout
    .toString()
    .split("\n")
    .flatMap((line) => {
      const [pid, ...command] = line.trim().split(/\s+/);
      const parsed = Number(pid);
      return Number.isSafeInteger(parsed) && command.join(" ").includes(marker) ? [parsed] : [];
    });
}

async function waitForProcessExit(marker: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (matchingPids(marker).length > 0 && Date.now() < deadline) {
    await Bun.sleep(25);
  }
  expect(matchingPids(marker)).toEqual([]);
}

function killMatchingProcesses(marker: string): void {
  for (const pid of matchingPids(marker)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

function termIgnoringCommand(marker: string): string {
  return `trap '' TERM; printf '%s\\n' '${marker}'; while :; do sleep 1; done`;
}

async function runTermIgnoringCommand(
  marker: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof runForeground>>> {
  const resultPromise = runForeground(
    termIgnoringCommand(marker),
    timeoutMs,
    process.cwd(),
    signal,
  );
  const deadline = Date.now() + 1_000;
  while (matchingPids(marker).length === 0 && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(matchingPids(marker)).not.toEqual([]);
  return resultPromise;
}

it.skipIf(isWindows)(
  "times out a TERM-ignoring foreground process with SIGKILL escalation",
  async () => {
    const marker = uniqueMarker();
    const started = Date.now();
    try {
      const result = await runTermIgnoringCommand(marker, 50);
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(5_000);
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Command timed out after");
    } finally {
      await waitForProcessExit(marker);
    }
  },
  { timeout: 6_000 },
);

it.skipIf(isWindows)(
  "aborts a TERM-ignoring foreground process with SIGKILL escalation",
  async () => {
    const marker = uniqueMarker();
    const controller = new AbortController();
    const started = Date.now();
    try {
      const resultPromise = runTermIgnoringCommand(marker, 10_000, controller.signal);
      await Bun.sleep(50);
      controller.abort();
      const result = await resultPromise;
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(5_000);
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Interrupted by user");
    } finally {
      await waitForProcessExit(marker);
    }
  },
  { timeout: 6_000 },
);

it.skipIf(isWindows)(
  "keeps SIGKILL escalation armed when stream draining rejects",
  async () => {
    const marker = uniqueMarker();
    const controller = new AbortController();
    let rejectedDrain = false;
    try {
      const resultPromise = runForeground(
        termIgnoringCommand(marker),
        10_000,
        process.cwd(),
        controller.signal,
        () => {
          if (rejectedDrain) return;
          rejectedDrain = true;
          controller.abort();
          throw new Error("foreground drain rejected");
        },
      );

      await expect(resultPromise).rejects.toThrow("foreground drain rejected");
      await waitForProcessExit(marker, 2_500);
    } finally {
      killMatchingProcesses(marker);
      await waitForProcessExit(marker);
    }
  },
  { timeout: 6_000 },
);

it("returns normal fast command output without timing out", async () => {
  const result = await runForeground("printf 'foreground fast output'", 1_000, process.cwd());

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("foreground fast output");
  expect(result.timedOut).toBe(false);
});
