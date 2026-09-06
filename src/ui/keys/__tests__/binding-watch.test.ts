import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appStore } from "@/store/index.ts";
import { bindingFilePath, reloadBindings, resetBindingsForTests } from "@/ui/keys/binding-file.ts";
import {
  bindingNoticeText,
  publishBindingNotice,
  stopWatching,
  watchBindingFile,
} from "@/ui/keys/binding-watch.ts";

// Owned by this file: the suite shares one process, so a config dir another file
// set is that file's to remove.
let scratch: string;
let priorConfigDir: string | undefined;

beforeEach(() => {
  priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  scratch = mkdtempSync(join(tmpdir(), "otherside-binding-watch-"));
  process.env.OTHERSIDE_CONFIG_DIR = scratch;
  resetBindingsForTests();
});

afterEach(() => {
  stopWatching();
  publishBindingNotice(0);
  if (priorConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;
  rmSync(scratch, { recursive: true, force: true });
  resetBindingsForTests();
});

function noticeText(): string | undefined {
  return appStore
    .getState()
    .rightRegion.persistents.find(
      (notice: { key: string; text: string }) => notice.key === "key-bindings",
    )?.text;
}

/**
 * Waits for a filesystem event to have been noticed, rather than for a fixed
 * stretch of clock. The watch settles on its own schedule and the machine may be
 * busy, so a fixed sleep is a coin flip dressed as an assertion.
 */
async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("what the reader is told", () => {
  test("counts rather than lists, and points at the command", () => {
    // The footer has one line; the detail belongs to the command that opens the file.
    expect(bindingNoticeText(1)).toBe("1 key binding could not be applied — /keybindings");
    expect(bindingNoticeText(3)).toBe("3 key bindings could not be applied — /keybindings");
  });

  test("says nothing when the file asked for nothing it could not have", () => {
    expect(bindingNoticeText(0)).toBeNull();
  });

  test("takes the notice away once the file reads clean", () => {
    publishBindingNotice(2);
    expect(noticeText()).toContain("2 key bindings");
    publishBindingNotice(0);
    expect(noticeText()).toBeUndefined();
  });
});

describe("watching the file", () => {
  test("reports what boot already found, without an edit", () => {
    writeFileSync(
      bindingFilePath(),
      JSON.stringify({ bindings: [{ context: "select", bindings: { "ctrl+c": "select:next" } }] }),
      "utf8",
    );
    // The boot read is what fills the problems the watch then reports.
    reloadBindings();
    watchBindingFile();
    expect(noticeText()).toContain("1 key binding");
  });

  test("picks up an edit and clears the notice when it reads clean", async () => {
    writeFileSync(bindingFilePath(), JSON.stringify({ bindings: 7 }), "utf8");
    reloadBindings();
    watchBindingFile();
    expect(noticeText()).toContain("1 key binding");

    writeFileSync(
      bindingFilePath(),
      JSON.stringify({ bindings: [{ context: "select", bindings: { n: "select:next" } }] }),
      "utf8",
    );
    // The settle window has to pass first — an editor saves in several writes, and
    // reading between them finds a document nobody wrote — and then the read has to
    // happen, which is the filesystem's schedule rather than ours.
    await until(() => noticeText() === undefined);
    expect(noticeText()).toBeUndefined();
  });

  test("starting twice replaces the first watch rather than stacking one", () => {
    const stopFirst = watchBindingFile();
    const stopSecond = watchBindingFile();
    stopFirst();
    stopSecond();
    // Both teardowns are the same idempotent stop; calling either twice is safe.
    expect(() => {
      stopSecond();
    }).not.toThrow();
  });
});
