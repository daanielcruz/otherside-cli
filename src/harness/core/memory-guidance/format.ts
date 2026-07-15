// Single source of truth for the memory-file pattern, shared by the system
// prompt's memory section (compact + full) and the dream skill. A drifted
// copy in any consumer produced memories with dates baked into file names.

export const MEMORY_FRONTMATTER_TEMPLATE = [
  "```markdown",
  "---",
  "name: <short-kebab-case-slug — never carries a date>",
  "description: <one-line summary — used to decide relevance during recall>",
  "metadata:",
  "  type: user | feedback | project | reference",
  "  created: <YYYY-MM-DD>",
  "  updated: <YYYY-MM-DD — refresh on every edit>",
  "---",
  "",
  "<the fact; for feedback/project, follow with **Why:** and **How to apply:** lines. Link related memories with [[their-name]].>",
  "```",
].join("\n");

export const MEMORY_DATES_RULE =
  "Dates are metadata only: they live in `metadata.created`/`metadata.updated`, never in the file name, `name:` slug, title, or index line. In the body, a dated marker is allowed only when the date itself is load-bearing (an owner decision, a landed/shifted change).";

export const MEMORY_CONSOLIDATION_RULE =
  'Consolidate on every touch: one topic = one file. When new signal overlaps an existing memory, merge into that file and delete the duplicate — never keep two files on the same subject. A memory earns its place by teaching a future session what to DO; plain history ("we did X", closed status, release recaps) is dead weight — rewrite it into the durable lesson or delete it, and be hardest on the oldest memories.';
