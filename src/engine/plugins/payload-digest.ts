import { createHash, type Hash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { ORPHANED_MARKER_FILENAME } from "./prune.ts";

/**
 * Entries that are bookkeeping rather than plugin content: a fetched plugin's own
 * repository metadata differs on every clone, and the orphan stamp belongs to the
 * payload sweep.
 */
const NON_CONTENT_ENTRIES: ReadonlySet<string> = new Set([".git", ORPHANED_MARKER_FILENAME]);
const EXECUTABLE_BITS = 0o111;

/**
 * A digest of a plugin payload: every path in the tree, the kind of entry it is,
 * whether a file is executable, and its bytes. Two payloads with the same digest
 * install the same plugin.
 */
export function payloadDigest(root: string): string {
  const hash = createHash("sha256");
  hashDirectory(hash, root, "");
  return hash.digest("hex");
}

function hashDirectory(hash: Hash, root: string, relativeDir: string): void {
  const names = readdirSync(join(root, relativeDir))
    .filter((name) => !NON_CONTENT_ENTRIES.has(name))
    .sort();
  for (const name of names) {
    const relativePath = join(relativeDir, name);
    const absolutePath = join(root, relativePath);
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      hashEntry(hash, "link", relativePath, readlinkSync(absolutePath));
    } else if (stats.isDirectory()) {
      hashEntry(hash, "dir", relativePath, "");
      hashDirectory(hash, root, relativePath);
    } else if (stats.isFile()) {
      const kind = (stats.mode & EXECUTABLE_BITS) === 0 ? "file" : "exec";
      hashEntry(hash, kind, relativePath, readFileSync(absolutePath));
    }
  }
}

/** Length-framed so no two different trees can feed the hash the same byte stream. */
function hashEntry(hash: Hash, kind: string, relativePath: string, content: string | Buffer): void {
  const body = typeof content === "string" ? Buffer.from(content) : content;
  hash.update(`${kind}\0${relativePath}\0${body.length}\0`);
  hash.update(body);
}
