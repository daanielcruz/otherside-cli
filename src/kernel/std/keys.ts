export function withStableIds(lines: string[]): { id: string; line: string }[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const count = seen.get(line) ?? 0;
    seen.set(line, count + 1);
    return { id: `${line}:${count}`, line };
  });
}
