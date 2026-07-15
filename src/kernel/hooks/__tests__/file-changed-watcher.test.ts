import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { FileChangedEventKind } from "../events.ts";
import { startFileChangedWatcher, stopFileChangedWatcher } from "../file-changed-watcher.ts";

const TEST_CONFIG = {
  hooks: {
    FileChanged: [{ matcher: "target.txt", command: "true" }],
  },
} as Pick<UserConfig, "hooks">;

describe("FileChanged watcher", () => {
  afterEach(() => {
    stopFileChangedWatcher();
  });

  test("debounces one external file change into one event and stops after teardown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otherside-filechanged-"));
    const target = join(dir, "target.txt");
    writeFileSync(target, "before");

    const calls: Array<{ filePath: string; event: FileChangedEventKind }> = [];
    const started = startFileChangedWatcher({
      cwd: dir,
      config: TEST_CONFIG,
      debounceMs: 150,
      fire: (filePath, event) => calls.push({ filePath, event }),
    });

    expect(started).toBe(true);
    await sleep(20);
    writeFileSync(target, "after");

    await waitFor(() => calls.length === 1);
    await sleep(200);

    expect(calls).toHaveLength(1);
    const firstCall = calls[0];
    if (!firstCall) throw new Error("missing watcher event");
    expect(firstCall.filePath).toBe(target);
    expect(["change", "add"]).toContain(firstCall.event);

    stopFileChangedWatcher();
    writeFileSync(target, "after teardown");
    await sleep(100);

    expect(calls).toHaveLength(1);
  });

  test("ignores common dependency and metadata directories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otherside-filechanged-"));
    const metadataDir = join(dir, ".git");
    const dependencyDir = join(dir, "node_modules");
    mkdirSync(metadataDir);
    mkdirSync(dependencyDir);
    const metadataFile = join(metadataDir, "target.txt");
    const dependencyFile = join(dependencyDir, "target.txt");
    writeFileSync(metadataFile, "before");
    writeFileSync(dependencyFile, "before");

    const calls: Array<{ filePath: string; event: FileChangedEventKind }> = [];
    startFileChangedWatcher({
      cwd: dir,
      config: TEST_CONFIG,
      debounceMs: 40,
      fire: (filePath, event) => calls.push({ filePath, event }),
    });

    await sleep(20);
    writeFileSync(metadataFile, "after");
    writeFileSync(dependencyFile, "after");
    await sleep(100);

    expect(calls).toEqual([]);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 1_500) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error("timed out waiting for watcher event");
}
