export function parseSelectionResponse(raw: string): string[] | null {
  const unfenced = raw
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const list = (parsed as Record<string, unknown>).selected_memories;
  if (!Array.isArray(list)) return null;
  return list.filter((f): f is string => typeof f === "string");
}
