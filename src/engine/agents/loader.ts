import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { publish } from "@/engine/background/tasks/bus.ts";
import { parseMcpServerSpec } from "@/kernel/mcp/config.ts";
import type { McpServerSpec } from "@/kernel/mcp/index.ts";
import { errorMessage } from "@/kernel/std/errno.ts";
import { PERMISSION_MODES } from "@/kernel/std/types/permission-mode.ts";
import { integerFromStringOrUndefined } from "@/kernel/std/value-guards.ts";
import {
  FrontmatterError,
  hasFrontmatterFence,
  type Parsed,
  parseFrontmatter,
} from "./frontmatter.ts";
import { register, type SubagentDef, type SubagentScope } from "./registry.ts";

export interface AgentLoadFailure {
  path: string;
  error: string;
}

export interface DirectoryLoad {
  defs: SubagentDef[];
  failures: AgentLoadFailure[];
}

interface DefSource {
  id: string;
  parsed: Parsed;
  scope: SubagentScope;
  sourcePath?: string;
}

export function loadFromMarkdown(
  id: string,
  src: string,
  scope: SubagentScope = "builtin",
  sourcePath?: string,
): SubagentDef {
  const parsed = parseFrontmatter(src);
  return defFromParsed({
    id,
    parsed,
    scope,
    ...(sourcePath !== undefined ? { sourcePath } : {}),
  });
}

export function loadAndRegister(
  id: string,
  src: string,
  scope: SubagentScope = "builtin",
  sourcePath?: string,
): SubagentDef {
  const def = loadFromMarkdown(id, src, scope, sourcePath);
  register(def);
  return def;
}

export function loadFromDirectory(dir: string, scope: SubagentScope): DirectoryLoad {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { defs: [], failures: [] };
  }
  const defs: SubagentDef[] = [];
  const failures: AgentLoadFailure[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    if (!isRegularFile(path)) continue;
    let src: string;
    try {
      src = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (!hasFrontmatterFence(src)) continue;
    const id = entry.replace(/\.md$/, "");
    try {
      const parsed = parseFrontmatter(src);
      if (!isAgentAttempt(parsed)) continue;
      const def = defFromParsed({ id, parsed, scope, sourcePath: path });
      register(def);
      defs.push(def);
    } catch (error) {
      failures.push({ path, error: errorText(error) });
    }
  }
  return { defs, failures };
}

function defFromParsed({ id, parsed, scope, sourcePath }: DefSource): SubagentDef {
  const description = parsed.fields.description?.trim() ?? "";
  if (description.length === 0) {
    throw new FrontmatterError('missing required "description" field in frontmatter');
  }
  const whenToUseLean = parsed.fields.whenToUseLean?.trim();
  const maxTurnsRaw = integerFromStringOrUndefined(parsed.fields.maxTurns);
  const maxTurns = maxTurnsRaw !== undefined && maxTurnsRaw > 0 ? maxTurnsRaw : undefined;
  const permissionModeRaw = parsed.fields.permissionMode?.trim();
  const permissionMode = PERMISSION_MODES.find((m) => m === permissionModeRaw);
  return {
    id,
    name: parsed.fields.name ?? id,
    description,
    ...(whenToUseLean !== undefined && whenToUseLean.length > 0 ? { whenToUseLean } : {}),
    body: parsed.body,
    tools: parsed.tools,
    disallowedTools: parsed.disallowedTools,
    model: { ...parsed.model },
    background: parsed.fields.background === "true",
    scope,
    ...(sourcePath !== undefined ? { sourcePath } : {}),
    mcpServers: mcpServersFromParsed(parsed.mcpServers),
    skills: parsed.skills,
    hooks: parsed.hooks,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  };
}

function mcpServersFromParsed(raw: string[] | null): McpServerSpec[] | null {
  if (raw === null) return null;
  const specs: McpServerSpec[] = [];
  for (const entry of raw) {
    const spec = parseMcpServerSpec(entry);
    if (spec !== null) specs.push(spec);
  }
  return specs;
}

function isAgentAttempt(parsed: Parsed): boolean {
  return !!parsed.fields.name?.trim() || !!parsed.fields.description?.trim();
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  return errorMessage(error);
}

export function publishLoadFailures(failures: AgentLoadFailure[]): void {
  for (const failure of failures) {
    publish("error", `Failed to parse agent file ${failure.path}: ${failure.error}`);
  }
}
