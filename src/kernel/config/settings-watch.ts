import { type FSWatcher, watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import { policySettingsSources } from "@/kernel/config/resolver.ts";
import { projectSettingsPath, type SettingScope, userSettingsPath } from "@/kernel/config/scope.ts";

/**
 * Tells the session when a settings file it reads changed on disk.
 *
 * Config is read from disk on demand, so nothing here keeps a value correct — it
 * exists so surfaces that resolved config once (a status row repainting per
 * keystroke cannot afford disk I/O on the key path) and hooks that want to
 * observe a change both learn that re-reading is now worth it.
 *
 * The watch is on the DIRECTORY, not the file: a settings file is replaced by
 * writing a temp beside it and renaming it over the original, which gives the
 * path a new inode, and a watch held on the old one goes deaf without saying so.
 */

/** Every scope backed by a file; `session` lives in memory and cannot change on disk. */
export type WatchedSettingScope = Exclude<SettingScope, "session">;

export interface SettingsChange {
  scope: WatchedSettingScope;
  /** The settings file itself, never the temp a writer renamed over it. */
  path: string;
}

/**
 * How long a file must sit still before subscribers are told. A save lands in
 * several writes, and a reader that runs between them finds a truncated document
 * — which would resolve config from a file nobody wrote.
 */
export const SETTLE_MS = 150;

export interface SettingsWatchOptions {
  /**
   * Decides whether a settled change is announced. A session rules on it with its
   * ConfigChange hooks, which may refuse — and a refused change is never announced,
   * so every reader goes on reading config as it was.
   */
  accept?: (change: SettingsChange) => boolean | Promise<boolean>;
}

/** What a name appearing in a watched directory means, or null when it is not ours. */
type ChangeOfName = (name: string) => SettingsChange | null;

const subscribers = new Set<(change: SettingsChange) => void>();
let watchers: FSWatcher[] = [];
let settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
let accept: NonNullable<SettingsWatchOptions["accept"]> = () => true;

/**
 * Subscribes to settled changes. Returns a teardown; subscribing does not start
 * the watch, so a subscriber on a path where nothing started it simply never
 * hears anything.
 */
export function onSettingsChanged(listener: (change: SettingsChange) => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

/**
 * Starts watching the settings files a working directory resolves config from.
 * Returns a teardown; calling it twice is safe and starting twice replaces the
 * first watch.
 */
export function watchSettingsFiles(cwd: string, options: SettingsWatchOptions = {}): () => void {
  stopWatchingSettings();
  accept = options.accept ?? (() => true);
  for (const [directory, changeOf] of watchedDirectories(cwd)) {
    try {
      watchers.push(
        watch(directory, (_event, changed) => {
          if (changed === null) return;
          const change = changeOf(basename(changed.toString()));
          if (change !== null) scheduleNotify(change);
        }),
      );
    } catch {
      // The directory does not exist yet, or the platform cannot watch it. Config
      // is still read from disk on demand, so this only costs the live notice.
    }
  }
  return stopWatchingSettings;
}

export function stopWatchingSettings(): void {
  for (const watcher of watchers) watcher.close();
  watchers = [];
  for (const timer of settleTimers.values()) clearTimeout(timer);
  settleTimers = new Map();
  accept = () => true;
}

/**
 * What each watched directory's names mean. Two scopes can share a directory —
 * the config root holds both the user file and the managed one — so rules landing
 * on the same directory compose rather than replace.
 */
function watchedDirectories(cwd: string): Map<string, ChangeOfName> {
  const rules = new Map<string, ChangeOfName>();
  const claimFile = (path: string, scope: WatchedSettingScope): void => {
    const name = basename(path);
    // A temp written beside the file is that file being replaced, so it counts as
    // the change — reported against the settled path rather than the temp's name.
    compose(rules, dirname(path), (seen) => (seen.startsWith(name) ? { scope, path } : null));
  };

  claimFile(userSettingsPath(), "user");
  claimFile(projectSettingsPath(cwd, "project"), "project");
  claimFile(projectSettingsPath(cwd, "local"), "local");
  for (const { file, dropDir } of policySettingsSources()) {
    claimFile(file, "policy");
    compose(rules, dropDir, (seen) =>
      seen.endsWith(".json") ? { scope: "policy", path: join(dropDir, seen) } : null,
    );
  }
  return rules;
}

function compose(rules: Map<string, ChangeOfName>, directory: string, rule: ChangeOfName): void {
  const existing = rules.get(directory);
  rules.set(directory, existing === undefined ? rule : (name) => existing(name) ?? rule(name));
}

/** One timer per file: two files changing at once are two changes, not one. */
function scheduleNotify(change: SettingsChange): void {
  const pending = settleTimers.get(change.path);
  if (pending !== undefined) clearTimeout(pending);
  const timer = setTimeout(() => {
    settleTimers.delete(change.path);
    void announce(change);
  }, SETTLE_MS);
  timer.unref?.();
  settleTimers.set(change.path, timer);
}

async function announce(change: SettingsChange): Promise<void> {
  let accepted = true;
  try {
    accepted = await accept(change);
  } catch {
    // A ruling that could not be made is not a refusal.
  }
  if (!accepted) return;
  for (const listener of [...subscribers]) {
    try {
      listener(change);
    } catch {
      // One subscriber throwing must not cost the others their notice.
    }
  }
}
