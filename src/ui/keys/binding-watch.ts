import { type FSWatcher, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { pluralize } from "@/kernel/std/text/pluralize.ts";
import {
  RightNoticeKey,
  removePersistent,
  upsertPersistent,
} from "@/store/app-store/right-region-notices.ts";
import { bindingFilePath, bindingProblems, reloadBindings } from "@/ui/keys/binding-file.ts";

/**
 * Keeps the binding table matching the file while the session runs, and says once
 * when the file asked for something that could not be given.
 *
 * The watch is on the DIRECTORY, not the file: an editor that saves by writing a
 * temp file and renaming it over the original replaces the inode, and a watch held
 * on the old one goes deaf without ever saying so.
 */

/**
 * How long the file must sit still before it is read. An editor saves in several
 * writes, and reading between them finds a truncated document — which would report
 * a syntax error the reader never wrote and then correct itself a moment later.
 */
export const SETTLE_MS = 150;

let watcher: FSWatcher | undefined;
let settleTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The one line the reader sees, or null when the file asked for nothing it could
 * not have. Counted rather than listed: the footer has one line, and the command
 * that opened the file is where the detail belongs.
 */
export function bindingNoticeText(problemCount: number): string | null {
  if (problemCount <= 0) return null;
  const count = `${problemCount} ${pluralize(problemCount, "key binding")}`;
  return `${count} could not be applied — /keybindings`;
}

/** Publishes the count, or takes the notice away once the file reads clean. */
export function publishBindingNotice(problemCount: number): void {
  const text = bindingNoticeText(problemCount);
  if (text === null) {
    removePersistent(RightNoticeKey.keyBindings);
    return;
  }
  upsertPersistent({
    key: RightNoticeKey.keyBindings,
    text,
    tone: "warning",
    priority: "low",
  });
}

/**
 * Starts watching, and reports what the boot read already found. Returns a
 * teardown; calling it twice is safe and starting twice replaces the first watch.
 */
export function watchBindingFile(): () => void {
  stopWatching();
  publishBindingNotice(bindingProblems().length);
  const path = bindingFilePath();
  const directory = dirname(path);
  const name = basename(path);
  try {
    watcher = watch(directory, (_event, changed) => {
      // A rename event carries the temp name on some editors and null on others,
      // so anything that is not clearly a different file is worth settling on.
      if (changed !== null && changed !== name && !changed.startsWith(name)) return;
      scheduleReload();
    });
  } catch {
    // No config directory yet, or a platform that cannot watch it. The file is
    // still read at boot and by the command, so this only costs live reloading.
    watcher = undefined;
  }
  return stopWatching;
}

export function stopWatching(): void {
  watcher?.close();
  watcher = undefined;
  if (settleTimer !== undefined) clearTimeout(settleTimer);
  settleTimer = undefined;
}

function scheduleReload(): void {
  if (settleTimer !== undefined) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = undefined;
    publishBindingNotice(reloadBindings().problems.length);
  }, SETTLE_MS);
  settleTimer.unref?.();
}
