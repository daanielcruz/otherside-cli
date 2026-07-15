import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { devtoolPath } from "@/devtools/settings.ts";

export type McpPayloadStage = "transport-result" | "returned-result";

export interface McpPayloadContext {
  serverName: string;
  toolName: string;
  toolUseId: string;
}

export function recordMcpPayload(
  stage: McpPayloadStage,
  payload: unknown,
  context: McpPayloadContext,
): void {
  const path = devtoolPath("mcpPayloadDiagnostics");
  if (!path) return;
  try {
    const measured = measureStrings(payload);
    const memory = process.memoryUsage();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({
        at: new Date().toISOString(),
        stage,
        ...context,
        ...measured,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        arrayBufferBytes: memory.arrayBuffers,
      })}\n`,
      { mode: 0o600 },
    );
  } catch {}
}

function measureStrings(value: unknown): {
  stringCount: number;
  stringChars: number;
  stringBytes: number;
  largestStringBytes: number;
} {
  const seen = new WeakSet<object>();
  let stringCount = 0;
  let stringChars = 0;
  let stringBytes = 0;
  let largestStringBytes = 0;

  const visit = (field: unknown): void => {
    if (typeof field === "string") {
      const bytes = Buffer.byteLength(field, "utf8");
      stringCount += 1;
      stringChars += field.length;
      stringBytes += bytes;
      largestStringBytes = Math.max(largestStringBytes, bytes);
      return;
    }
    if (typeof field !== "object" || field === null || seen.has(field)) return;
    seen.add(field);
    if (Array.isArray(field)) {
      for (const item of field) visit(item);
      return;
    }
    for (const item of Object.values(field as Record<string, unknown>)) visit(item);
  };

  visit(value);
  return { stringCount, stringChars, stringBytes, largestStringBytes };
}
