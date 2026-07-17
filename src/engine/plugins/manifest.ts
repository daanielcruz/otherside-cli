import { z } from "zod";

// Hook types handled by dedicated runtimes elsewhere — the loader accepts them
// in a manifest (passthrough) but never turns them into command/prompt hooks.
export const NON_COMMAND_HOOK_TYPES = ["mcp_tool", "http", "agent"] as const;
export type NonCommandHookType = (typeof NON_COMMAND_HOOK_TYPES)[number];

const NON_COMMAND_HOOK_TYPE_SET: ReadonlySet<string> = new Set(NON_COMMAND_HOOK_TYPES);
export function isNonCommandHookType(value: unknown): value is NonCommandHookType {
  return typeof value === "string" && NON_COMMAND_HOOK_TYPE_SET.has(value);
}

export const HookCommandSchema = z.union([
  z.object({
    type: z.literal("command").optional(),
    command: z.string(),
    args: z.array(z.string()).optional(),
    timeout: z.number().optional(),
    timeoutMs: z.number().optional(),
  }),
  z.object({
    type: z.literal("prompt"),
    prompt: z.string(),
    timeout: z.number().optional(),
    timeoutMs: z.number().optional(),
  }),
  z
    .object({
      type: z.enum(NON_COMMAND_HOOK_TYPES),
    })
    .passthrough(),
]);

const HookEntrySchema = z.union([
  z.object({
    type: z.literal("command").optional(),
    matcher: z.string(),
    command: z.string(),
    timeoutMs: z.number().optional(),
  }),
  z.object({
    type: z.literal("prompt"),
    matcher: z.string(),
    prompt: z.string(),
    timeoutMs: z.number().optional(),
  }),
  z.object({
    matcher: z.string().optional(),
    hooks: z.array(HookCommandSchema),
  }),
]);

const HooksConfigSchema = z.record(z.string(), z.array(HookEntrySchema));

const CommandMetadataSchema = z.object({
  source: z.string().optional(),
  content: z.string().optional(),
  description: z.string().optional(),
  argumentHint: z.string().optional(),
  model: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
});

export const McpServerConfigSchema = z
  .object({
    type: z.enum(["stdio", "http", "sse"]).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    oauth: z.object({ scope: z.string().optional() }).optional(),
    cwd: z.string().optional(),
  })
  .refine(
    (server) =>
      server.type === "stdio"
        ? typeof server.command === "string" && server.url === undefined
        : server.type === "http" || server.type === "sse"
          ? typeof server.url === "string" && server.command === undefined
          : (typeof server.command === "string") !== (typeof server.url === "string"),
    { message: "mcp server must declare exactly one transport" },
  );

const McpServersRecordSchema = z.record(z.string(), McpServerConfigSchema);
const McpServersSpecSchema = z.union([
  z.string(),
  McpServersRecordSchema,
  z.array(z.union([z.string(), McpServersRecordSchema])),
]);

const LspServerConfigSchema = z
  .object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    extensionToLanguage: z.record(z.string(), z.string()).optional(),
    extensions: z.array(z.string()).optional(),
    languages: z.array(z.string()).optional(),
  })
  .refine(
    (server) =>
      server.extensionToLanguage !== undefined ||
      (server.extensions !== undefined && server.extensions.length > 0),
    { message: "lsp server must declare extensionToLanguage or extensions" },
  );

const AuthorSchema = z.object({
  name: z.string(),
  email: z.string().optional(),
  url: z.string().optional(),
});

const KEBAB_CASE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const PluginManifestSchema = z.object({
  name: z.string().regex(KEBAB_CASE_RE, "name must be kebab-case with no spaces"),

  version: z.string().optional(),

  description: z.string().optional(),

  author: AuthorSchema.optional(),

  homepage: z.string().optional(),

  repository: z.string().optional(),

  commands: z
    .union([z.string(), z.array(z.string()), z.record(z.string(), CommandMetadataSchema)])
    .optional(),

  agents: z.union([z.string(), z.array(z.string())]).optional(),

  skills: z.union([z.string(), z.array(z.string())]).optional(),

  hooks: z
    .union([z.string(), HooksConfigSchema, z.array(z.union([z.string(), HooksConfigSchema]))])
    .optional(),

  mcpServers: McpServersSpecSchema.optional(),

  lspServers: z.union([z.string(), z.record(z.string(), LspServerConfigSchema)]).optional(),

  dependencies: z.array(z.string()).optional(),
});

export type CommandMetadata = z.infer<typeof CommandMetadataSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type LspServerConfig = z.infer<typeof LspServerConfigSchema>;
export type HooksConfig = z.infer<typeof HooksConfigSchema>;
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginId = `${string}@${string}`;

export function parseManifest(raw: unknown): PluginManifest {
  return PluginManifestSchema.parse(raw);
}

export { PluginManifestSchema };
