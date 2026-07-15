import { truncateEllipsis } from "@/kernel/std/text/text.ts";

export function previewArgs(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "url", "query", "description"]) {
    const v = obj[key];
    if (typeof v === "string") return truncateEllipsis(v.replace(/\n/g, " "), 200);
  }
  try {
    return truncateEllipsis(JSON.stringify(input), 200);
  } catch {
    return "";
  }
}
