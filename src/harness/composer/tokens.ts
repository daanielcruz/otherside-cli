export function applyTokens(source: string, tokens: Record<string, string>): string {
  let out = source;
  for (const [token, value] of Object.entries(tokens)) {
    out = out.split(token).join(value);
  }
  return out;
}
