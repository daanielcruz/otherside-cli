export function pluralize(n: number, singular: string, plural?: string): string {
  if (n === 1) return singular;
  return plural ?? `${singular}s`;
}
