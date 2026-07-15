import { isAbsolute, resolve } from "node:path";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";

export function activePlanFilePath(sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9._-]/g, "-") || "session";
  return resolve(configRoot(), "plans", `${safeSessionId}.md`);
}

export function isActivePlanFileWrite(
  input: unknown,
  ctx?: Pick<RequestContext, "sessionId" | "cwd">,
): boolean {
  if (!ctx || !isRecord(input)) return false;
  const filePath = input.file_path;
  if (typeof filePath !== "string" || !isAbsolute(filePath)) return false;
  return resolve(filePath) === resolve(activePlanFilePath(ctx.sessionId));
}
