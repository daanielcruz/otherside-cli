import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeInternalWrite,
  forgetInternalWrites,
  markInternalWrite,
} from "@/kernel/config/internal-writes.ts";
import {
  projectSettingsPath,
  userSettingsPath,
  writeProjectSettings,
} from "@/kernel/config/scope.ts";
import {
  onSettingsChanged,
  SETTLE_MS,
  type SettingsChange,
  stopWatchingSettings,
  watchSettingsFiles,
} from "@/kernel/config/settings-watch.ts";

// Owned by this file: the suite shares one process, so a config dir another file
// set is that file's to restore.
let configDir: string;
let projectDir: string;
let priorConfigDir: string | undefined;
const teardowns: Array<() => void> = [];

beforeEach(() => {
  priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  configDir = mkdtempSync(join(tmpdir(), "otherside-settings-watch-"));
  projectDir = mkdtempSync(join(tmpdir(), "otherside-settings-project-"));
  process.env.OTHERSIDE_CONFIG_DIR = configDir;
  mkdirSync(join(projectDir, ".otherside"), { recursive: true });
  // A directory is only watched once it holds a settings file, so both scopes
  // start with one.
  writeFileSync(userSettingsPath(), "{}");
  writeFileSync(projectSettingsPath(projectDir, "project"), "{}");
});

afterEach(() => {
  stopWatchingSettings();
  for (const teardown of teardowns.splice(0)) teardown();
  forgetInternalWrites();
  if (priorConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;
  rmSync(configDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

interface Watching {
  /** Changes that reached a subscriber. */
  announced: SettingsChange[];
  /** Changes the gate was asked to rule on, announced or not. */
  ruled: SettingsChange[];
}

/**
 * Starts the watch and hands back what it says, quiet. A file written moments
 * before the watch starts can still have its event delivered afterwards, which
 * would read as the change the test is about to make — so the opening is drained.
 */
async function startWatching(accept?: (change: SettingsChange) => boolean): Promise<Watching> {
  const seen: Watching = { announced: [], ruled: [] };
  teardowns.push(onSettingsChanged((change) => seen.announced.push(change)));
  watchSettingsFiles(projectDir, {
    accept: (change) => {
      seen.ruled.push(change);
      return accept?.(change) ?? true;
    },
  });
  await sleep(SETTLE_MS * 3);
  seen.announced.length = 0;
  seen.ruled.length = 0;
  return seen;
}

/**
 * Waits for a filesystem event to have been noticed rather than for a fixed
 * stretch of clock: the watch settles on its own schedule and the machine may be
 * busy, so a fixed sleep is a coin flip dressed as an assertion.
 */
async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await sleep(10);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("which file belongs to which scope", () => {
  test("names the user file as the user scope", async () => {
    const seen = await startWatching();

    writeFileSync(userSettingsPath(), '{"theme":"dark"}');
    await until(() => seen.announced.length > 0);
    expect(seen.announced[0]?.scope).toBe("user");
    expect(seen.announced[0]?.path).toBe(userSettingsPath());
  });

  test("tells the project file from the local one sitting beside it", async () => {
    const local = projectSettingsPath(projectDir, "local");
    const seen = await startWatching();

    writeFileSync(local, '{"outputStyle":"Explanatory"}');
    await until(() => seen.announced.length > 0);
    expect(seen.announced[0]?.scope).toBe("local");
    expect(seen.announced[0]?.path).toBe(local);
  });

  test("reports a write made through the settings writer against the file, not its temp", async () => {
    const project = projectSettingsPath(projectDir, "project");
    const seen = await startWatching();

    // The writer replaces the file by renaming a temp over it, so the directory
    // sees a name the reader never wrote.
    writeProjectSettings(projectDir, "project", (file) => {
      (file as Record<string, unknown>).outputStyle = "Explanatory";
    });
    await until(() => seen.announced.length > 0);
    expect(seen.announced.every((change) => change.path === project)).toBe(true);
    expect(seen.announced[0]?.scope).toBe("project");
  });

  test("says nothing about a file that is not a settings file", async () => {
    const seen = await startWatching();

    writeFileSync(join(configDir, "keybindings.json"), "{}");
    await until(() => seen.announced.length > 0, 500);
    expect(seen.announced).toHaveLength(0);
  });
});

describe("ruling on a change before anyone is told", () => {
  test("a refused change reaches nobody", async () => {
    const seen = await startWatching(() => false);

    writeFileSync(userSettingsPath(), '{"theme":"dark"}');
    await until(() => seen.ruled.length > 0);
    expect(seen.ruled[0]?.scope).toBe("user");
    expect(seen.announced).toHaveLength(0);
  });

  test("a ruling that throws is not a refusal", async () => {
    const seen = await startWatching(() => {
      throw new Error("hook could not run");
    });

    writeFileSync(userSettingsPath(), '{"theme":"dark"}');
    await until(() => seen.announced.length > 0);
    expect(seen.announced).toHaveLength(1);
  });
});

describe("stopping", () => {
  test("leaves nothing listening, and stopping twice is safe", async () => {
    const seen = await startWatching();
    stopWatchingSettings();
    stopWatchingSettings();

    writeFileSync(userSettingsPath(), '{"theme":"dark"}');
    await until(() => seen.announced.length > 0, 500);
    expect(seen.announced).toHaveLength(0);
  });

  test("a listener that unsubscribed hears nothing more", async () => {
    const gone: SettingsChange[] = [];
    const unsubscribe = onSettingsChanged((change) => gone.push(change));
    unsubscribe();
    await startWatching();

    writeFileSync(userSettingsPath(), '{"theme":"dark"}');
    await until(() => gone.length > 0, 500);
    expect(gone).toHaveLength(0);
  });
});

describe("telling this session's own writes from the reader's", () => {
  test("a marked write is claimed once and only once", () => {
    const path = userSettingsPath();
    markInternalWrite(path);
    expect(consumeInternalWrite(path)).toBe(true);
    // The record is spent: a second change to the same file is the reader's.
    expect(consumeInternalWrite(path)).toBe(false);
  });

  test("a file this session never wrote is never claimed", () => {
    expect(consumeInternalWrite(userSettingsPath())).toBe(false);
  });
});
