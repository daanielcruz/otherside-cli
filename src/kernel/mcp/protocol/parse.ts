import { DEFAULT_INPUT_SCHEMA } from "./constants.ts";
import {
  MCP_SKILLS_EXTENSION_URI,
  type McpDirectoryEntry,
  type McpResourceInfo,
  type McpServerCapabilities,
  type McpToolInfo,
} from "./types.ts";

export function parseInstructions(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>).instructions;
  return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
}

export function parseServerCapabilities(value: unknown): McpServerCapabilities | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const caps = root.capabilities;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return null;
  return caps as McpServerCapabilities;
}

/** True when the server advertised a `resources` capability (object or true). */
export function hasResourcesCapability(
  capabilities: McpServerCapabilities | null | undefined,
): boolean {
  return !!capabilities?.resources;
}

/**
 * Call-time check: skills extension declares `directoryRead: true`.
 * Tool *appearance* is gated only by resources; this gates the directory call.
 */
export function hasDirectoryReadCapability(
  capabilities: McpServerCapabilities | null | undefined,
): boolean {
  const ext = capabilities?.extensions?.[MCP_SKILLS_EXTENSION_URI];
  return (
    ext != null &&
    typeof ext === "object" &&
    !Array.isArray(ext) &&
    (ext as Record<string, unknown>).directoryRead === true
  );
}

export function parseMcpTool(value: unknown): McpToolInfo | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name : null;
  if (!name) return null;
  const description = typeof obj.description === "string" ? obj.description : "";
  const title = typeof obj.title === "string" ? obj.title : undefined;
  const annotations =
    obj.annotations && typeof obj.annotations === "object" && !Array.isArray(obj.annotations)
      ? (obj.annotations as Record<string, unknown>)
      : {};
  const raw = obj.inputSchema ?? obj.input_schema;
  const inputSchema =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : DEFAULT_INPUT_SCHEMA;
  return {
    name,
    description,
    inputSchema,
    ...(title ? { title } : {}),
    ...(typeof annotations.readOnlyHint === "boolean"
      ? { readOnlyHint: annotations.readOnlyHint }
      : {}),
    ...(typeof annotations.destructiveHint === "boolean"
      ? { destructiveHint: annotations.destructiveHint }
      : {}),
    ...(typeof annotations.openWorldHint === "boolean"
      ? { openWorldHint: annotations.openWorldHint }
      : {}),
  };
}

export function parseMcpResource(value: unknown): McpResourceInfo | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const out: McpResourceInfo = {
    ...(typeof obj.uri === "string" ? { uri: obj.uri } : {}),
    ...(typeof obj.name === "string" ? { name: obj.name } : {}),
    ...(typeof obj.description === "string" ? { description: obj.description } : {}),
    ...(typeof obj.mimeType === "string" ? { mimeType: obj.mimeType } : {}),
  };
  return Object.keys(out).length > 0 ? out : null;
}

export function parseDirectoryEntry(value: unknown): McpDirectoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const uri = typeof obj.uri === "string" ? obj.uri : null;
  const name = typeof obj.name === "string" ? obj.name : null;
  if (!uri || !name) return null;
  return {
    uri,
    name,
    ...(typeof obj.description === "string" ? { description: obj.description } : {}),
    ...(typeof obj.mimeType === "string" ? { mimeType: obj.mimeType } : {}),
  };
}

/** Strip format/control chars from untrusted MCP text (names, mime types). */
export function sanitizeMcpText(text: string): string {
  let res = text.replace(/[\p{Cf}\p{Co}\p{Cn}]/gu, "");
  res = res
    .replace(/[\u200B-\u200F]/g, "")
    .replace(/[\u202A-\u202E]/g, "")
    .replace(/[\u2066-\u2069]/g, "")
    .replace(/[\uFEFF]/g, "")
    .replace(/[\uE000-\uF8FF]/g, "");
  return res;
}

/** Decode + sanitize untrusted MCP URIs (iterate until stable, max 10 passes). */
export function sanitizeMcpUri(uri: string): string {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    // keep as-is
  }
  let t = decoded;
  for (let n = 0; n < 10; n++) {
    const r = sanitizeMcpText(t);
    if (r === t) return t;
    t = r;
  }
  return t;
}
