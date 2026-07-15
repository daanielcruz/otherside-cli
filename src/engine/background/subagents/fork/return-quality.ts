export function isTooShortForReturn(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 80) return true;
  const lower = trimmed.toLowerCase();
  if (/^(done|ok|okay|finished|complete|completed)\.?$/i.test(trimmed)) return true;
  if (lower.split(/\s+/).length < 12) return true;
  return false;
}
