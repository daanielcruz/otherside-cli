import { existsSync, type FSWatcher, readdirSync, statSync, watch } from "node:fs";
import { basename, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { FileChangedEventKind } from "./events.ts";

const DEFAULT_DEBOUNCE_MS = 500;
const IGNORED_SEGMENTS = new Set([".git", "node_modules"]);

type Timer = ReturnType<typeof setTimeout>;

export interface StartFileChangedWatcherOptions {
  cwd: string;
  config: Pick<UserConfig, "hooks">;
  fire: (filePath: string, event: FileChangedEventKind) => void;
  debounceMs?: number;
}

interface PendingChange {
  timer: Timer;
}

let watchers: FSWatcher[] = [];
let pending = new Map<string, PendingChange>();
let active: StartFileChangedWatcherOptions | null = null;

export function startFileChangedWatcher(options: StartFileChangedWatcherOptions): boolean {
  stopFileChangedWatcher();
  if ((options.config.hooks?.FileChanged?.length ?? 0) === 0) return false;

  active = options;
  try {
    watchers = [
      watch(options.cwd, { recursive: true, persistent: true }, (eventType, filename) => {
        queueFsEvent(options.cwd, eventType, filename);
      }),
    ];
    return true;
  } catch {
    try {
      watchDirectoryTree(options.cwd);
      return watchers.length > 0;
    } catch {
      stopFileChangedWatcher();
      return false;
    }
  }
}

export function stopFileChangedWatcher(): void {
  for (const watcher of watchers) {
    watcher.close();
  }
  watchers = [];
  for (const change of pending.values()) {
    clearTimeout(change.timer);
  }
  pending = new Map();
  active = null;
}

function watchDirectoryTree(dir: string): void {
  if (isIgnoredPath(dir, active?.cwd ?? dir)) return;
  watchers.push(
    watch(dir, { persistent: true }, (eventType, filename) => {
      queueFsEvent(dir, eventType, filename);
      if (eventType === "rename" && filename) {
        const child = join(dir, filename.toString());
        if (isDirectory(child) && !isIgnoredPath(child, active?.cwd ?? dir)) {
          watchDirectoryTree(child);
        }
      }
    }),
  );

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = join(dir, entry.name);
    watchDirectoryTree(child);
  }
}

function queueFsEvent(root: string, eventType: string, filename: string | Buffer | null): void {
  const options = active;
  if (!options || !filename) return;

  const filenameText = filename.toString();
  const absPath = normalize(isAbsolute(filenameText) ? filenameText : join(root, filenameText));
  if (isIgnoredPath(absPath, options.cwd)) return;

  const event = eventFromFsEvent(eventType, absPath);
  if (event !== "unlink" && isDirectory(absPath)) return;
  if (!matchesAnyFileChangedHook(options.config, absPath)) return;

  const previous = pending.get(absPath);
  if (previous) clearTimeout(previous.timer);

  const timer = setTimeout(() => {
    pending.delete(absPath);
    const current = active;
    if (!current) return;
    current.fire(absPath, eventFromFsEvent(eventType, absPath));
  }, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);

  pending.set(absPath, { timer });
}

function eventFromFsEvent(eventType: string, filePath: string): FileChangedEventKind {
  if (eventType === "change") return "change";
  return existsSync(filePath) ? "add" : "unlink";
}

function matchesAnyFileChangedHook(config: Pick<UserConfig, "hooks">, filePath: string): boolean {
  const entries = config.hooks?.FileChanged ?? [];
  const name = basename(filePath);
  return entries.some((entry) => matchesFileMatcher(entry.matcher, name));
}

export function matchesFileMatcher(pattern: string, filename: string): boolean {
  if (pattern === "" || pattern === "*") return true;
  if (/^[a-zA-Z0-9_.|-]+$/.test(pattern)) {
    return pattern
      .split("|")
      .map((part) => part.trim())
      .includes(filename);
  }
  try {
    return new RegExp(pattern).test(filename);
  } catch {
    return false;
  }
}

function isIgnoredPath(filePath: string, root: string): boolean {
  const rel = relative(root, filePath);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) return false;
  return rel.split(sep).some((segment) => IGNORED_SEGMENTS.has(segment));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
