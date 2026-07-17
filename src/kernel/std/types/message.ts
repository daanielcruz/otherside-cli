import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { ImageDimensions, ImageMediaType } from "@/kernel/std/types/image.ts";

export interface MessageUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: ContentBlock[];
  id?: string;
  requestId?: string;
  usage?: MessageUsageSnapshot;
  producedBy?: ProviderId;
  producedModel?: string;
  producedAccount?: string;
  ts?: number;
}

export function lastAssistantRequestId(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant" && msg.requestId) return msg.requestId;
  }
  return undefined;
}

export interface CacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
  scope?: "global";
}

export type ToolResultContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: ImageMediaType; data: string };
      dimensions?: ImageDimensions;
    }
  | {
      type: "pdf";
      source: { type: "base64"; media_type: "application/pdf"; data: string };
      filename: string;
      pageCount: number;
      bytes: number;
    }
  | { type: "tool_reference"; tool_name: string };

export const PDF_UNAVAILABLE_PLACEHOLDER =
  "[PDF content is unavailable on this provider. Re-read the file to provide page images.]";

export function toolResultText(content: string | ToolResultContentBlock[]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image") {
      const dims = block.dimensions;
      const w = dims?.displayWidth ?? dims?.originalWidth;
      const h = dims?.displayHeight ?? dims?.originalHeight;
      const dimStr = w !== undefined && h !== undefined ? ` ${w}x${h}` : "";
      parts.push(`[image: ${block.source.media_type}${dimStr}]`);
    } else if (block.type === "pdf") {
      parts.push(PDF_UNAVAILABLE_PLACEHOLDER);
    }
  }
  return parts.join("\n");
}

export type ContentBlock =
  | { type: "text"; text: string; cache_control?: CacheControl }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | ToolResultContentBlock[];
      is_error?: boolean;
      cache_control?: CacheControl;
    }
  // Thinking replay is bound to the provider, model, and credential that
  // produced the block, and message-level stamps do not survive history
  // rebuilds that merge assistant messages from different producers, so the
  // block carries its own stamp. Builders gate replay on the block stamp and
  // fall back to the message stamp only for legacy unstamped blocks.
  | {
      type: "thinking";
      text: string;
      signature?: string;
      producedBy?: ProviderId;
      producedModel?: string;
      producedAccount?: string;
    }
  | {
      type: "image";
      source: { type: "base64"; media_type: ImageMediaType; data: string };
      dimensions?: ImageDimensions;
    };

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type ToolResultMeta =
  | {
      kind: "bash";
      status: string;
      exit_code?: number;
      stdout?: string;
      stderr?: string;
      elapsed_ms?: number;
      shell_id?: string;
      search_summary?: { lines: number };
      no_output_expected?: boolean;
      return_code_interpretation?: string;
      sed_edit?: { file_path: string; diff: string };
    }
  | { kind: "read"; numLines: number; startLine: number; totalLines: number }
  | { kind: "image"; bytes: number; visionModel?: string }
  | { kind: "ask"; declined: true }
  | { kind: "ask"; declined: false; answers: { question: string; answer: string }[] };

export interface ToolResult {
  tool_use_id: string;
  content: string | ToolResultContentBlock[];
  is_error?: boolean;
  meta?: ToolResultMeta;
}

export function toolResultIsErrorField(
  isError: boolean | undefined,
  meta: ToolResultMeta | undefined,
): { is_error?: boolean } {
  if (isError === true) return { is_error: true };
  if (meta?.kind === "bash") return { is_error: false };
  return {};
}
