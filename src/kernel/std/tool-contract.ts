import { isAbsolute, resolve } from "node:path";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ToolArgSegment =
  | { kind: "text"; text: string }
  | { kind: "path"; text: string; path: string };

export function filePathSegment(filePath: string): ToolArgSegment {
  const absolute = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  return { kind: "path", text: filePath, path: absolute };
}

export interface ToolRenderHooks {
  userFacingLabel?: (input: unknown) => string;
  userFacingDescription?: () => string;
  summarizeArgs?: (input: unknown) => string;
  summarizeArgSegments?: (input: unknown) => ToolArgSegment[];
  formatResult?: (content: string, input: unknown) => string;
  isTransparent?: (input: unknown) => boolean;
}

export interface ToolHandler {
  schema: ToolSchema;
  run(call: ToolCall, ctx: RequestContext): Promise<ToolResult>;
  render?: ToolRenderHooks;
  isConcurrencySafe?: boolean;
  coerceInput?(input: unknown): unknown;
  steerValidationError?(input: unknown): string | null;
  requiresUserInteraction?(): boolean;
}
