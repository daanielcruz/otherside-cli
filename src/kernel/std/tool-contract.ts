import { isAbsolute, resolve } from "node:path";
import { getDisplayPath } from "@/kernel/std/fs/paths.ts";
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

/** A file argument, read relative to the working directory when it lies inside it. */
export function filePathSegment(filePath: string): ToolArgSegment {
  const absolute = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  return { kind: "path", text: getDisplayPath(filePath), path: absolute };
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
  /** A call this returns true for runs without a permission prompt; deny and ask rules still apply. */
  isPermissionFree?(input: unknown): boolean;
}
