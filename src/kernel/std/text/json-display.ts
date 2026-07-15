export function stringifyForDisplay(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
