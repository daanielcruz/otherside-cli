import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { announceToConnected } from "@/kernel/mcp/client/registry.ts";
import { registerInboundResponder } from "@/kernel/mcp/protocol/inbound.ts";
import { loadAdditionalDirectories } from "@/kernel/permissions/persist.ts";

/**
 * The directories a server is allowed to reach.
 *
 * A server asks for these so it can scope its own work to what the session is
 * about instead of the whole filesystem. The answer is the working directory
 * plus whatever the reader granted beyond it — the same set the permission layer
 * treats as inside, so a server is never told about a place a tool would refuse.
 */

export const ROOTS_METHOD = "roots/list";

export interface McpRoot {
  uri: string;
  name: string;
}

/** What a server is told when the set changes under it. */
export const ROOTS_CHANGED_NOTICE = "notifications/roots/list_changed";

/**
 * Tells every connected server the set moved. They ask again when they care;
 * the notice carries no list of its own.
 */
export function announceRootsChanged(): void {
  announceToConnected(ROOTS_CHANGED_NOTICE, {});
}

/** Starts answering `roots/list`. Returns a teardown. */
export function serveRoots(cwd: () => string): () => void {
  return registerInboundResponder(ROOTS_METHOD, async () => ({
    roots: await sessionRoots(cwd()),
  }));
}

/** The working directory first, then the granted ones, each named once. */
export async function sessionRoots(cwd: string): Promise<McpRoot[]> {
  const granted = await loadAdditionalDirectories(cwd).catch(() => [] as string[]);
  const seen = new Set<string>();
  const roots: McpRoot[] = [];
  for (const directory of [cwd, ...granted]) {
    if (directory.length === 0 || seen.has(directory)) continue;
    seen.add(directory);
    roots.push({ uri: pathToFileURL(directory).href, name: basename(directory) || directory });
  }
  return roots;
}
