import { describe, expect, it } from "bun:test";
import { realpath } from "node:fs/promises";
import { runProcessSafely, runProcessSafelyFromDir } from "@/kernel/std/proc/run-process.ts";

const RUNTIME = process.execPath;

function runtimeScript(source: string): string[] {
  return ["-e", source];
}

describe("runProcessSafelyFromDir", () => {
  it("preserves both streams from a failed process by default", async () => {
    const result = await runProcessSafelyFromDir(
      RUNTIME,
      runtimeScript('process.stdout.write("out"); process.stderr.write("err"); process.exit(7);'),
      {},
    );

    expect(result).toMatchObject({ stdout: "out", stderr: "err", code: 7 });
    expect(result.error).toContain("exit code 7");
  });

  it("discards both streams when failed output is disabled", async () => {
    const result = await runProcessSafelyFromDir(
      RUNTIME,
      runtimeScript('process.stdout.write("out"); process.stderr.write("err"); process.exit(9);'),
      { preserveOutputOnError: false },
    );

    expect(result).toEqual({ stdout: "", stderr: "", code: 9 });
  });

  it("always resolves when the executable is missing", async () => {
    const result = await runProcessSafelyFromDir("missing-process-wrapper-test-executable", []);

    // Windows resolves the miss through the shell: exit 1 with a localized
    // stderr message naming the executable, never an ENOENT errno.
    if (process.platform === "win32") {
      expect(result.code).toBe(1);
      expect(result.error).toContain("missing-process-wrapper-test-executable");
      return;
    }
    expect(result).toEqual({
      stdout: "",
      stderr: "",
      code: 1,
      error: expect.stringContaining("ENOENT"),
    });
  });

  it("returns a failed result after timeout", async () => {
    const result = await runProcessSafelyFromDir(RUNTIME, runtimeScript("await Bun.sleep(5_000)"), {
      timeout: 20,
    });

    expect(result).toMatchObject({ stdout: "", stderr: "", code: 1 });
    expect(result.error).toContain("timed out after 20 milliseconds");
  });

  it("maps abortSignal to process cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runProcessSafelyFromDir(RUNTIME, runtimeScript("await Bun.sleep(5_000)"), {
      abortSignal: controller.signal,
    });

    expect(result).toMatchObject({ stdout: "", stderr: "", code: 1 });
    expect(result.error).toContain("canceled");
  });

  it("keeps the omitted-options maxBuffer behavior distinct from an empty object", async () => {
    const source = 'process.stdout.write("x".repeat(1_000_001))';
    const omitted = await runProcessSafelyFromDir(RUNTIME, runtimeScript(source));
    const explicit = await runProcessSafelyFromDir(RUNTIME, runtimeScript(source), {});

    expect(omitted).toMatchObject({
      code: 0,
      error: expect.stringContaining("maxBuffer exceeded"),
    });
    expect(omitted.stdout).toHaveLength(1_000_000);
    expect(explicit).toEqual({ stdout: "x".repeat(1_000_001), stderr: "", code: 0 });
  });
});

describe("runProcessSafely", () => {
  it("uses the current working directory when requested", async () => {
    const result = await runProcessSafely(
      RUNTIME,
      runtimeScript("process.stdout.write(process.cwd())"),
    );

    expect(result).toEqual({ stdout: await realpath(process.cwd()), stderr: "", code: 0 });
  });
});
