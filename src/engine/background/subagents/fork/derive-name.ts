/**
 * Derive a short agent display name from a fork directive.
 * First three whitespace-split tokens, lowercased, non-alnum stripped,
 * collapsed hyphens, max 24 chars.
 */
export function deriveForkName(directive: string): string {
  return (
    directive
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24) || "fork"
  );
}

/** Single-line description used in the background task list (max 50 chars). */
export function forkDescriptionFromDirective(directive: string): string {
  const collapsed = directive.replace(/\s+/g, " ").trim();
  return collapsed.length > 50 ? `${collapsed.slice(0, 49)}…` : collapsed;
}
