import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { LspServerSpec } from "@/kernel/lsp/client.ts";
import { expandPluginRoot } from "@/kernel/std/fs/plugin-root.ts";
import type { LspServerConfig as ManifestLspServerConfig } from "./manifest.ts";
import * as plugins from "./registry.ts";

function resolveMaybePath(
  value: string,
  pluginDir: string,
  existsSyncFn: (path: string) => boolean,
): string {
  const expanded = expandPluginRoot(value, pluginDir);
  if (isAbsolute(expanded) || expanded.startsWith("-")) return expanded;
  const candidate = join(pluginDir, expanded);
  return existsSyncFn(candidate) ? candidate : expanded;
}

function resolveWorkingDirectory(value: string | undefined, pluginDir: string): string | undefined {
  if (value === undefined) return undefined;
  const expanded = expandPluginRoot(value, pluginDir);
  return isAbsolute(expanded) ? expanded : join(pluginDir, expanded);
}

function expandEnv(
  env: Record<string, string> | undefined,
  pluginDir: string,
): Record<string, string> | undefined {
  if (env === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) out[key] = expandPluginRoot(value, pluginDir);
  return out;
}

function extensionToLanguage(server: ManifestLspServerConfig): Record<string, string> | null {
  if (server.extensionToLanguage !== undefined) {
    const entries = Object.entries(server.extensionToLanguage);
    if (entries.length === 0) return null;
    return Object.fromEntries(entries.map(([ext, language]) => [ext.toLowerCase(), language]));
  }

  const extensions = server.extensions ?? [];
  const languages = server.languages ?? [];
  if (extensions.length === 0) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < extensions.length; i += 1) {
    const ext = extensions[i];
    if (ext === undefined) continue;
    out[ext.toLowerCase()] = languages[i] ?? languages[0] ?? "plaintext";
  }
  return Object.keys(out).length > 0 ? out : null;
}

function adaptServer(
  server: ManifestLspServerConfig,
  pluginDir: string,
  existsSyncFn: (path: string) => boolean,
): LspServerSpec | null {
  const languageByExtension = extensionToLanguage(server);
  if (languageByExtension === null) return null;
  const spec: LspServerSpec = {
    command: resolveMaybePath(server.command, pluginDir, existsSyncFn),
    args: (server.args ?? []).map((arg) => resolveMaybePath(arg, pluginDir, existsSyncFn)),
    languages: [...new Set(Object.values(languageByExtension))],
    extensions: Object.keys(languageByExtension),
    extensionToLanguage: languageByExtension,
  };
  const env = expandEnv(server.env, pluginDir);
  if (env !== undefined) spec.env = env;
  const cwd = resolveWorkingDirectory(server.cwd, pluginDir);
  if (cwd !== undefined) spec.cwd = cwd;
  return spec;
}

export function gatherPluginLspServerSpecs(options?: {
  existsSync?: (path: string) => boolean;
}): LspServerSpec[] {
  const existsSyncFn = options?.existsSync ?? existsSync;
  const out: LspServerSpec[] = [];
  for (const plugin of plugins.list()) {
    if (!plugins.isRuntimeEnabled(plugin.name)) continue;
    const spec = plugin.manifest.lspServers;
    if (!spec || typeof spec === "string") continue;
    for (const server of Object.values(spec)) {
      const adapted = adaptServer(server, plugin.path, existsSyncFn);
      if (adapted !== null) out.push(adapted);
    }
  }
  return out;
}

export function hasEnabledPluginLspServers(): boolean {
  for (const plugin of plugins.list()) {
    if (!plugins.isRuntimeEnabled(plugin.name)) continue;
    const spec = plugin.manifest.lspServers;
    if (spec && typeof spec !== "string" && Object.keys(spec).length > 0) return true;
  }
  return false;
}
