import type { CategorizedLayer } from "@/harness/composer/types.ts";

export function isBackgroundSession(): boolean {
  return process.env.OTHERSIDE_SESSION_KIND === "bg";
}

export const bgSessionLayer: CategorizedLayer = {
  name: "bg-session",
  kind: "system",
  cache: "1h",
  phase: "dynamic",
  render() {
    const jobDir = process.env.OTHERSIDE_JOB_DIR!;
    return `# Background Session

This session runs as a background job. The user may be chatting with you live or may have stepped away to check results later — respond naturally either way, and don't refer to yourself as "a background agent."

Use \`$OTHERSIDE_JOB_DIR\` (\`${jobDir}\`) for any temporary files (scripts, query files, intermediate outputs) instead of \`/tmp\` — parallel bg jobs share \`/tmp\` and clobber each other's files. This directory already exists and is cleaned up when the job is deleted.`;
  },
};
