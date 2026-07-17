import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigSync, projectConfigKey } from "@/kernel/config/config.ts";
import {
  canonicalizeCwd,
  configRoot,
  gitAncestorRoot,
  isEphemeralCwd,
  projectPath,
  projectSlug,
  projectsRoot,
  worktreePathsFor,
  worktreePathsForAsync,
} from "@/kernel/std/fs/paths.ts";

const HEAD_BYTES = 131072;

export function currentGitBranch(cwd: string): string | null {
  let dir = cwd;
  for (let depth = 0; depth < 64; depth += 1) {
    const head = join(dir, ".git", "HEAD");
    try {
      const raw = readFileSync(head, "utf8").trim();
      const m = raw.match(/^ref:\s+refs\/heads\/(.+)$/);
      return m?.[1] ?? null;
    } catch {
      const parent = join(dir, "..");
      if (parent === dir) return null;
      dir = parent;
    }
  }
  return null;
}

export function legacySessionsRoot(): string {
  return join(configRoot(), "sessions");
}

export function sessionsRootForCwd(cwd: string): string {
  if (isEphemeralCwd(cwd)) return join(ephemeralSessionsRoot(), projectSlug(cwd));
  return projectPath(cwd);
}

export function ephemeralSessionsRoot(): string {
  return process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR ?? join(tmpdir(), "otherside-sessions");
}

function sessionDiscoveryRoots(): string[] {
  return [projectsRoot(), ephemeralSessionsRoot()];
}

interface ProjectDirRef {
  root: string;
  projectDirName: string;
}

function listProjectDirsSync(): ProjectDirRef[] {
  const out: ProjectDirRef[] = [];
  for (const root of sessionDiscoveryRoots()) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const projectDirName of names) out.push({ root, projectDirName });
  }
  return out;
}

async function listProjectDirs(): Promise<ProjectDirRef[]> {
  const perRoot = await Promise.all(
    sessionDiscoveryRoots().map(async (root): Promise<ProjectDirRef[]> => {
      try {
        return (await readdir(root)).map((projectDirName) => ({ root, projectDirName }));
      } catch {
        return [];
      }
    }),
  );
  return perRoot.flat();
}

export function sessionPathForCwd(cwd: string, id: string): string {
  return join(sessionsRootForCwd(cwd), `${id}.jsonl`);
}

export function agentTranscriptPathForCwd(cwd: string, sessionId: string, agentId: string): string {
  return join(sessionsRootForCwd(cwd), sessionId, "subagents", `agent-${agentId}.jsonl`);
}

export function forkSpecPathForCwd(cwd: string, sessionId: string, forkId: string): string {
  return join(sessionsRootForCwd(cwd), sessionId, "subagents", `agent-${forkId}.spec.json`);
}

export function forkStopPathForCwd(cwd: string, sessionId: string, forkId: string): string {
  return join(sessionsRootForCwd(cwd), sessionId, "subagents", `agent-${forkId}.stopped`);
}

export interface SessionFileMeta {
  id: string;
  path: string;
  mtime: number;
  cwd: string | null;
  hasUserMessage: boolean;
}

export interface SessionFileRef {
  id: string;
  path: string;
  mtime: number;
  size: number;
}

export function listSessionFileRefs(): SessionFileRef[] {
  const out: SessionFileRef[] = [];
  for (const { root, projectDirName } of listProjectDirsSync()) {
    const projectDir = join(root, projectDirName);
    let entries: string[];
    try {
      entries = readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(projectDir, name);
      try {
        const st = statSync(path);
        out.push({ id: name.slice(0, -".jsonl".length), path, mtime: st.mtimeMs, size: st.size });
      } catch {}
    }
  }
  return out;
}

export interface SessionCwdFilter {
  matchSet: Set<string>;
  slugSet: Set<string>;
}

export function sessionCwdFilterSeed(cwd: string): SessionCwdFilter {
  const matchSet = new Set<string>([cwd, canonicalizeCwd(cwd)]);
  return filterFromMatchSet(matchSet);
}

export async function sessionCwdFilterFor(cwd: string): Promise<SessionCwdFilter> {
  const matchSet = new Set<string>([cwd]);
  const canonical = canonicalizeCwd(cwd);
  matchSet.add(canonical);
  for (const wt of await worktreePathsForAsync(canonical)) matchSet.add(wt);
  for (const slotPath of projectWorktreeSlotPaths(canonical)) matchSet.add(slotPath);
  return filterFromMatchSet(matchSet);
}

function filterFromMatchSet(matchSet: Set<string>): SessionCwdFilter {
  const slugSet = new Set<string>();
  for (const path of matchSet) slugSet.add(projectSlug(path));
  return { matchSet, slugSet };
}

export interface SessionFileStat {
  id: string;
  path: string;
  mtime: number;
  sizeBytes: number;
  slugMatched: boolean;
}

export function listSlugSessionFileStats(filter: SessionCwdFilter): SessionFileStat[] {
  const out: SessionFileStat[] = [];
  for (const root of sessionDiscoveryRoots()) {
    for (const slug of filter.slugSet) {
      const projectDir = join(root, slug);
      let entries: string[];
      try {
        entries = readdirSync(projectDir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(projectDir, name);
        try {
          const fileStat = statSync(path);
          out.push({
            id: name.slice(0, -".jsonl".length),
            path,
            mtime: fileStat.mtimeMs,
            sizeBytes: fileStat.size,
            slugMatched: true,
          });
        } catch {}
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export async function listSessionFileStats(filter?: SessionCwdFilter): Promise<SessionFileStat[]> {
  const perDir = await Promise.all(
    (await listProjectDirs()).map(({ root, projectDirName }) =>
      statProjectDir({ root, projectDirName, filter }),
    ),
  );
  const out = perDir.flat();
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

interface StatProjectDirInput {
  root: string;
  projectDirName: string;
  filter: SessionCwdFilter | undefined;
}

async function statProjectDir(input: StatProjectDirInput): Promise<SessionFileStat[]> {
  const projectDir = join(input.root, input.projectDirName);
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return [];
  }
  const slugMatched = input.filter === undefined || input.filter.slugSet.has(input.projectDirName);
  const stats = await Promise.all(
    entries
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => {
        const path = join(projectDir, name);
        try {
          const fileStat = await stat(path);
          return {
            id: name.slice(0, -".jsonl".length),
            path,
            mtime: fileStat.mtimeMs,
            sizeBytes: fileStat.size,
            slugMatched,
          };
        } catch {
          return null;
        }
      }),
  );
  return stats.filter((entry): entry is SessionFileStat => entry !== null);
}

export function listSessionFiles(filterCwd?: string): SessionFileMeta[] {
  const matchSet = filterCwd === undefined ? null : buildMatchSet(filterCwd);
  const slugSet = matchSet === null ? null : slugSetFrom(matchSet);
  const out: SessionFileMeta[] = [];
  for (const { root, projectDirName } of listProjectDirsSync()) {
    const projectDir = join(root, projectDirName);
    let entries: string[];
    try {
      entries = readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      const path = join(projectDir, name);
      let mtime: number;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      const head = readSessionHead(path);
      if (matchSet !== null && slugSet !== null) {
        const cwdMatch = head.cwd !== null && matchSet.has(head.cwd);
        const slugMatch = slugSet.has(projectDirName);
        if (!cwdMatch && !slugMatch) continue;
      }
      out.push({ id, path, mtime, cwd: head.cwd, hasUserMessage: head.hasUserMessage });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function buildMatchSet(cwd: string): Set<string> {
  const set = new Set<string>();
  set.add(cwd);
  const canonical = canonicalizeCwd(cwd);
  set.add(canonical);
  for (const wt of worktreePathsFor(canonical)) set.add(wt);
  for (const slotPath of projectWorktreeSlotPaths(canonical)) set.add(slotPath);
  return set;
}

function slugSetFrom(matchSet: Set<string>): Set<string> {
  const slugs = new Set<string>();
  for (const path of matchSet) slugs.add(projectSlug(path));
  return slugs;
}

/**
 * Worktree paths recorded in this project's persisted worktree-session slot.
 * A crashed worktree session whose worktree was later removed is invisible to
 * `git worktree list`, but its transcript still lives under the worktree's
 * project dir — the slot is the only surviving pointer, so its path joins the
 * resume match set to keep that session findable from the original repo.
 */
function projectWorktreeSlotPaths(canonicalCwd: string): string[] {
  try {
    const keys = new Set<string>([projectConfigKey(canonicalCwd)]);
    const root = gitAncestorRoot(canonicalCwd);
    if (root !== null) keys.add(projectConfigKey(root));
    const out: string[] = [];
    for (const [key, entry] of Object.entries(loadConfigSync().projects ?? {})) {
      const slot = entry?.activeWorktreeSession;
      if (slot === undefined || !keys.has(key)) continue;
      if (typeof slot.activePath === "string" && slot.activePath.length > 0) {
        out.push(slot.activePath);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function latestSessionId(filterCwd?: string): string | null {
  const list = listSessionFiles(filterCwd);
  return list[0]?.id ?? null;
}

export function findSessionPath(id: string): string | null {
  for (const root of sessionDiscoveryRoots()) {
    let projectDirs: string[];
    try {
      projectDirs = readdirSync(root);
    } catch {
      continue;
    }
    for (const projectDirName of projectDirs) {
      const candidate = join(root, projectDirName, `${id}.jsonl`);
      try {
        statSync(candidate);
        return candidate;
      } catch {}
    }
  }
  return null;
}

interface SessionHead {
  cwd: string | null;
  hasUserMessage: boolean;
}

function readSessionHead(path: string): SessionHead {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const bytesRead = readSync(fd, buf, 0, HEAD_BYTES, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    let cwd: string | null = null;
    let hasUserMessage = false;
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      try {
        const obj = JSON.parse(line) as { type?: string; cwd?: string };
        if (typeof obj.cwd === "string" && obj.cwd.length > 0 && cwd === null) {
          cwd = obj.cwd;
        }
        if (obj.type === "user_message" || obj.type === "user") {
          hasUserMessage = true;
        }
        if (cwd !== null && hasUserMessage) break;
      } catch {}
    }
    return { cwd, hasUserMessage };
  } catch {
    return { cwd: null, hasUserMessage: false };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}
