import { afterEach, describe, expect, it } from "bun:test";
import { cleanupCwdFile, newCwdFilePath } from "../cwd.ts";
import { prepareExecCommand, shellSpawnEnvironment } from "../exec.ts";
import { runForeground } from "../foreground.ts";

async function run(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const cwdFile = newCwdFilePath();
  const { execCommand, login } = await prepareExecCommand({
    command,
    dangerouslyDisableSandbox: true,
    cwdFilePath: cwdFile,
  });
  const res = await runForeground(execCommand, 10_000, process.cwd(), undefined, undefined, login);
  cleanupCwdFile(cwdFile);
  return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
}

describe("shell subprocess environment", () => {
  it("prepends the small-heap option for every accepted remote value", () => {
    for (const value of ["1", "true", "yes", "on", " TRUE "]) {
      const parentEnv = { OTHERSIDE_REMOTE: value, BUN_OPTIONS: "--inspect" };
      const childEnv = shellSpawnEnvironment(parentEnv);

      expect(childEnv.BUN_OPTIONS).toBe("--smol --inspect");
      expect(parentEnv.BUN_OPTIONS).toBe("--inspect");
    }
  });

  it("sets only the small-heap option when no child option exists", () => {
    expect(shellSpawnEnvironment({ OTHERSIDE_REMOTE: "on" }).BUN_OPTIONS).toBe("--smol");
  });

  it("leaves child options unchanged outside remote mode", () => {
    for (const value of [undefined, "0", "false", "no", "off", "anything-else"]) {
      expect(
        shellSpawnEnvironment({ OTHERSIDE_REMOTE: value, BUN_OPTIONS: "--inspect" }).BUN_OPTIONS,
      ).toBe("--inspect");
    }
  });
});

describe("prepareExecCommand wrapping", () => {
  it("preserves a non-`exit` failure's code (the trailing cwd probe must not mask $?)", async () => {
    expect((await run("false")).exitCode).toBe(1);
  });

  it("propagates an explicit exit code", async () => {
    expect((await run("exit 7")).exitCode).toBe(7);
  });

  it("reports success as 0", async () => {
    expect((await run("true")).exitCode).toBe(0);
  });

  it("merges stderr into stdout in chronological order (single fd)", async () => {
    const { stdout, stderr } = await run("echo out; echo err >&2; echo out2");
    expect(stdout).toBe("out\nerr\nout2\n");
    expect(stderr).toBe("");
  });

  it("still captures the working directory after the command", async () => {
    expect((await run("cd /tmp && pwd")).stdout.trim()).toBe("/tmp");
  });
});

describe("drainStreamToString memory hygiene", () => {
  afterEach(() => {
    delete process.env.BASH_MAX_OUTPUT_LENGTH;
  });

  function stringToStream(s: string, chunkSize = 1024): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(s);
    let offset = 0;
    return new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        const chunk = bytes.subarray(offset, offset + chunkSize);
        offset += chunkSize;
        controller.enqueue(chunk);
      },
    });
  }

  it("drain under bound -> identical string", async () => {
    const testCap = 20;
    process.env.BASH_MAX_OUTPUT_LENGTH = String(testCap);

    const input = "abcdefghijklmnopqrst";
    const stream = stringToStream(input, 5);
    const { drainStreamToString } = await import("../exec.ts");
    const result = await drainStreamToString(stream, Promise.resolve(0));
    expect(result).toBe(input);
  });

  it("retains a post-exit chunk from the read that loses the initial grace race", async () => {
    let pullStarted = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullStarted) return;
        pullStarted = true;
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode("late-tail"));
          controller.close();
        }, 40);
      },
    });

    const { drainStreamToString } = await import("../exec.ts");
    expect(await drainStreamToString(stream, Promise.resolve(0))).toBe("late-tail");
  });

  it("drain over bound retains only the head and reports remaining lines", async () => {
    const testCap = 4;
    process.env.BASH_MAX_OUTPUT_LENGTH = String(testCap);

    const input = "head\nline 1\nline 2\n";
    const stream = stringToStream(input, 3);
    const { drainStreamToString } = await import("../exec.ts");
    const result = await drainStreamToString(stream, Promise.resolve(0));

    expect(result).toBe("head\n\n... [4 lines truncated] ...");
  });

  it("progress reporting on over bound remains bounded to the retained head", async () => {
    const testCap = 100;
    process.env.BASH_MAX_OUTPUT_LENGTH = String(testCap);

    const input = "abcdefghijklmnopqrstuvwxyz1234567890".repeat(25);
    const stream = stringToStream(input, 10);
    const progressUpdates: string[] = [];
    const { drainStreamToString } = await import("../exec.ts");
    const result = await drainStreamToString(stream, Promise.resolve(0), (acc) => {
      progressUpdates.push(acc);
    });

    expect(result).toBe(`${input.slice(0, testCap)}\n\n... [1 lines truncated] ...`);
    expect(progressUpdates.length).toBeGreaterThan(0);
    for (const update of progressUpdates) {
      expect(update.length).toBeLessThanOrEqual(testCap);
    }
  });
});
