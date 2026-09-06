import { existsSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { getTrackedCwd } from "@/kernel/std/state/cwd-state.ts";
import { canonicalProjectPath } from "./identity.ts";
import {
  listPluginInstallations,
  type PluginInstallation,
  pluginCacheRoot,
} from "./installations.ts";

// Payload teardown for uninstalled plugins is deferred, not immediate:
// uninstall stamps the payload directory with an `.orphaned_at` marker, and a
// background sweep at startup deletes marked directories once the marker is
// older than the retention window. The delay keeps a payload usable by any
// still-running session that loaded it before the uninstall. Reinstalling a
// version clears its marker (the sweep unmarks every referenced payload
// before it looks for deletions), so a marker never kills a live install.
//
// Two kinds of payload directory exist, and their lifetimes differ:
// - the per-installation payload (`installPath`) is owned by exactly one
//   (scope, project) installation, so it is marked as soon as that
//   installation is removed;
// - the download cache (`cachePath`) is shared by every scope that installed
//   the same version, so it is marked only when the last installation
//   referencing it goes away. Uninstalling one of two scopes therefore never
//   touches the other scope's payload or the shared cache.

export const ORPHANED_MARKER_FILENAME = ".orphaned_at";
export const ORPHANED_PAYLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function markPluginPayloadOrphaned(payloadDir: string): void {
  if (!existsSync(payloadDir)) return;
  try {
    writeFileSync(join(payloadDir, ORPHANED_MARKER_FILENAME), `${Date.now()}`);
  } catch {
    // Best-effort: a payload we cannot stamp is picked up by a later sweep,
    // which stamps unreferenced directories itself.
  }
}

/**
 * Clears a stale orphan marker after a payload directory became referenced
 * again (reinstall of a previously uninstalled version). The sweep would
 * self-heal this on the next startup; clearing eagerly keeps a fresh install
 * from carrying an orphan stamp in the meantime.
 */
export function clearPluginPayloadOrphanMarker(payloadDir: string): void {
  removeOrphanMarker(payloadDir);
}

/**
 * Called after an installation record has been removed. Stamps the payload
 * directories that lost their last reference so the startup sweep can delete
 * them after the retention window.
 */
export function markRemovedInstallationPayloads(removed: PluginInstallation): void {
  const remaining = listPluginInstallations();
  const installPath = resolve(removed.installPath);
  const cachePath = resolve(removed.cachePath);
  if (!remaining.some((entry) => resolve(entry.installPath) === installPath)) {
    markPluginPayloadOrphaned(installPath);
  }
  const cacheReferenced = remaining.some(
    (entry) => resolve(entry.cachePath) === cachePath || resolve(entry.installPath) === cachePath,
  );
  if (!cacheReferenced) markPluginPayloadOrphaned(cachePath);
}

/**
 * Fire-and-forget wrapper for the startup path: the sweep runs after the
 * current task so plugin loading never waits on filesystem cleanup.
 */
export function schedulePluginPayloadSweep(cwd?: string): void {
  const sweepCwd = cwd ?? getTrackedCwd();
  setTimeout(() => {
    try {
      sweepOrphanedPluginPayloads({ cwd: sweepCwd });
    } catch {}
  }, 0).unref?.();
}

export interface PluginPayloadSweepOptions {
  cwd?: string;
}

/**
 * Walks every payload root reachable from this process (the shared cache,
 * the user install root, and the current project's install roots), then:
 * - clears stale `.orphaned_at` markers from directories that are referenced
 *   by an installation record again (reinstall after uninstall);
 * - stamps unreferenced directories that carry no marker yet (covers
 *   payloads orphaned by older builds or by hand-edited records);
 * - deletes directories whose marker is older than the retention window and
 *   prunes parent directories left empty by the deletion.
 *
 * The sweep aborts without touching disk when the installation registry
 * cannot be read — without the reference set, orphan detection is unsafe.
 */
export function sweepOrphanedPluginPayloads(options?: PluginPayloadSweepOptions): void {
  let referenced: Set<string>;
  try {
    referenced = new Set(
      listPluginInstallations().flatMap((entry) => [
        resolve(entry.installPath),
        resolve(entry.cachePath),
      ]),
    );
  } catch {
    return;
  }
  const now = Date.now();
  for (const root of payloadRoots(options?.cwd ?? getTrackedCwd())) {
    sweepRoot(root, referenced, now);
  }
}

interface PayloadRoot {
  path: string;
  // Directory levels between the root and a version (payload) directory.
  versionDepth: number;
}

function payloadRoots(cwd: string): PayloadRoot[] {
  // Cache: <root>/<marketplace>/<name>/<version>.
  // Install roots: <root>/<scope>/<marketplace>/<name>/<version>.
  const roots: PayloadRoot[] = [
    { path: pluginCacheRoot(), versionDepth: 3 },
    { path: join(configRoot(), "plugins", "installed"), versionDepth: 4 },
  ];
  const projectPath = canonicalProjectPath(cwd);
  if (projectPath !== undefined) {
    roots.push(
      { path: join(projectPath, ".otherside", "plugins", "installed"), versionDepth: 4 },
      { path: join(projectPath, ".otherside", "plugins", "installed-local"), versionDepth: 4 },
    );
  }
  return roots;
}

function sweepRoot(root: PayloadRoot, referenced: ReadonlySet<string>, now: number): void {
  if (!existsSync(root.path)) return;
  for (const versionDir of directoriesAtDepth(root.path, root.versionDepth)) {
    if (referenced.has(versionDir)) {
      removeOrphanMarker(versionDir);
      continue;
    }
    processUnreferencedPayload(versionDir, now);
    removeEmptyParentsUpTo(versionDir, root.path);
  }
}

function directoriesAtDepth(root: string, depth: number): string[] {
  let current = [resolve(root)];
  for (let level = 0; level < depth; level += 1) {
    const next: string[] = [];
    for (const dir of current) next.push(...subdirectories(dir));
    current = next;
  }
  return current;
}

function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(dir, entry.name));
  } catch {
    return [];
  }
}

function removeOrphanMarker(payloadDir: string): void {
  try {
    unlinkSync(join(payloadDir, ORPHANED_MARKER_FILENAME));
  } catch {}
}

function processUnreferencedPayload(payloadDir: string, now: number): void {
  const marker = join(payloadDir, ORPHANED_MARKER_FILENAME);
  let markedAtMs: number;
  try {
    markedAtMs = statSync(marker).mtimeMs;
  } catch {
    markPluginPayloadOrphaned(payloadDir);
    return;
  }
  if (now - markedAtMs <= ORPHANED_PAYLOAD_RETENTION_MS) return;
  try {
    rmSync(payloadDir, { recursive: true, force: true });
  } catch {}
}

function removeEmptyParentsUpTo(versionDir: string, root: string): void {
  const resolvedRoot = resolve(root);
  let current = dirname(resolve(versionDir));
  while (current !== resolvedRoot && current.startsWith(`${resolvedRoot}${sep}`)) {
    if (hasAnyEntry(current)) return;
    try {
      rmSync(current, { recursive: true, force: true });
    } catch {
      return;
    }
    current = dirname(current);
  }
}

function hasAnyEntry(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return true;
  }
}
