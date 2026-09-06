import { LITE_READ_BYTES, readSessionLite } from "@/engine/session/lite.ts";
import {
  findSessionPath,
  listSessionFileStats,
  type SessionFileStat,
  sessionCwdFilterFor,
} from "@/engine/session/paths.ts";
import { titlesFromHeadTail } from "@/engine/session/title/store.ts";

export interface TitledSession {
  readonly id: string;
  readonly modifiedMs: number;
}

/**
 * More than one session in this project answers to the same title, so there is no
 * honest way to pick one. Carries the candidates so the caller can name them and let
 * the user resume by id instead.
 */
export class AmbiguousSessionTitleError extends Error {
  readonly title: string;
  readonly matches: readonly TitledSession[];

  constructor(title: string, matches: readonly TitledSession[]) {
    const listing = matches
      .map((match) => `  ${match.id}  (modified ${new Date(match.modifiedMs).toISOString()})`)
      .join("\n");
    super(
      `--resume "${title}" matches ${matches.length} sessions. Pass one of these session IDs instead:\n${listing}`,
    );
    this.name = "AmbiguousSessionTitleError";
    this.title = title;
    this.matches = matches;
  }
}

function comparable(title: string): string {
  return title.toLowerCase().trim();
}

async function customTitleAt(stat: SessionFileStat, buffer: Buffer): Promise<string | null> {
  const lite = await readSessionLite({ path: stat.path, sizeBytes: stat.sizeBytes, buffer });
  if (lite === null) return null;
  return titlesFromHeadTail(lite).customTitle ?? null;
}

/**
 * Sessions in this project whose user-assigned title is exactly `title`, most recent
 * first. Only a rename counts: a generated title is not something the user typed, so
 * resuming by one would resolve against a name they never chose.
 */
export async function findSessionsByTitle(title: string, cwd: string): Promise<TitledSession[]> {
  const wanted = comparable(title);
  if (wanted.length === 0) return [];
  const filter = await sessionCwdFilterFor(cwd);
  const stats = (await listSessionFileStats(filter)).filter((stat) => stat.slugMatched);
  const buffer = Buffer.alloc(LITE_READ_BYTES);
  const found: TitledSession[] = [];
  for (const stat of stats) {
    const custom = await customTitleAt(stat, buffer);
    if (custom !== null && comparable(custom) === wanted) {
      found.push({ id: stat.id, modifiedMs: stat.mtime });
    }
  }
  return found.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

/**
 * The session id `--resume <value>` refers to. An id is answered from the file it
 * names without reading any other session; anything else is looked up as a title.
 * A value that matches neither is handed back unchanged, so loading it fails with the
 * same not-found report a mistyped id has always produced.
 */
export async function resolveSessionRef(ref: string, cwd: string = process.cwd()): Promise<string> {
  if (findSessionPath(ref) !== null) return ref;
  const matches = await findSessionsByTitle(ref, cwd);
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) throw new AmbiguousSessionTitleError(ref, matches);
  return ref;
}

/**
 * A title as it must be written into a resume command: the shell has to hand the whole
 * title over as one argument, and the quotes and backslashes inside it have to survive
 * that trip intact.
 */
export function quoteTitleForResume(title: string): string {
  return `"${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
