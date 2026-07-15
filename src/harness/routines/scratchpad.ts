import { mkdirSync, realpathSync } from "node:fs";
import type { CategorizedLayer, LayerContext } from "@/harness/composer/types.ts";
import { projectSlug } from "@/kernel/std/fs/paths.ts";

function getTmpBase(): string {
  try {
    return realpathSync("/tmp");
  } catch {
    return "/tmp";
  }
}

const createdDirs = new Set<string>();

export function ensureScratchpadDir(dir: string): void {
  if (createdDirs.has(dir)) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    createdDirs.add(dir);
  } catch {
    // Errors creating -> still render the section (do not throw).
  }
}

// Boot/session-switch hook: create the dir eagerly so it exists before the
// first prompt render (render still ensures as a fallback).
export function initScratchpadDir(cwd: string, sessionId: string): void {
  ensureScratchpadDir(scratchpadDirFor(cwd, sessionId));
}

export function scratchpadDirFor(cwd: string, sessionId: string): string {
  const envDir = process.env.OTHERSIDE_SCRATCHPAD_DIR?.trim();
  if (envDir) return envDir;

  const tmpBase = getTmpBase();
  const uid = process.getuid?.() ?? 0;
  const sanitizedCwd = projectSlug(cwd);
  return `${tmpBase}/otherside-${uid}/${sanitizedCwd}/${sessionId}/scratchpad`;
}

export function scratchpadDir(ctx: LayerContext): string {
  // Keyed to the pre-isolation cwd: worktree forks rewrite ctx.cwd but must
  // share the spawning project's scratchpad.
  return scratchpadDirFor(ctx.originalCwd ?? ctx.cwd, ctx.sessionId);
}

export const scratchpadLayer: CategorizedLayer = {
  name: "scratchpad",
  kind: "system",
  cache: "1h",
  phase: "dynamic",
  render(ctx: LayerContext) {
    const dir = scratchpadDir(ctx);
    ensureScratchpadDir(dir);

    return `# Scratchpad Directory

IMPORTANT: Always use this scratchpad directory for temporary files instead of \`/tmp\` or other system temp directories:
\`${dir}\`

Use this directory for ALL temporary file needs:
- Storing intermediate results or data during multi-step tasks
- Writing temporary scripts or configuration files
- Saving outputs that don't belong in the user's project
- Creating working files during analysis or processing
- Any file that would otherwise go to \`/tmp\`

Only use \`/tmp\` if the user explicitly requests it.

The scratchpad directory is session-specific, isolated from the user's project, and can generally be used without permission prompts.`;
  },
};
