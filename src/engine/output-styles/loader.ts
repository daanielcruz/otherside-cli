import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { hasFrontmatterFence, parseFrontmatter } from "@/engine/agents/frontmatter.ts";
import {
  forcedPluginStyle,
  pluginOutputStyleDirs,
  pluginStyleName,
} from "@/engine/output-styles/plugin-styles.ts";
import {
  BUILT_IN_OUTPUT_STYLES,
  DEFAULT_OUTPUT_STYLE,
  type OutputStyleRecord,
} from "@/harness/routines/output-styles/built-in.ts";
import { systemPolicyDir } from "@/kernel/permissions/persist.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";

const PROJECT_STYLES_DIR = ".otherside";
const DESCRIPTION_MAX = 100;

function derivedDescription(content: string, fallback: string): string {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const text = trimmed.match(/^#+\s+(.+)$/)?.[1] ?? trimmed;
    return text.length > DESCRIPTION_MAX ? `${text.substring(0, DESCRIPTION_MAX - 3)}...` : text;
  }
  return fallback;
}

/**
 * Every style at a path, which may be a directory of them or one file. A plugin
 * shipping a single style should not have to make a directory to hold it.
 */
function readStylesDir(
  target: string,
  source: OutputStyleRecord["source"],
  namePrefix = "",
): OutputStyleRecord[] {
  let dir = target;
  let entries: string[];
  try {
    if (statSync(target).isFile()) {
      dir = dirname(target);
      entries = [basename(target)];
    } else {
      entries = readdirSync(target);
    }
  } catch {
    return [];
  }
  const records: OutputStyleRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    try {
      if (!statSync(path).isFile()) continue;
      const raw = readFileSync(path, "utf8");
      const { fields, body } = hasFrontmatterFence(raw)
        ? parseFrontmatter(raw)
        : { fields: {} as Record<string, string>, body: raw };
      const stem = basename(entry).replace(/\.md$/, "");
      const record: OutputStyleRecord = {
        name: namePrefix + (fields.name?.trim() || stem),
        description:
          fields.description?.trim() || derivedDescription(body, `Custom ${stem} output style`),
        prompt: body.trim(),
        source,
      };
      if (fields["keep-coding-instructions"] === "true") record.keepCodingInstructions = true;
      // Only a plugin can insist on its style; elsewhere the flag means nothing.
      if (source === "plugin" && fields["force-for-plugin"] === "true") {
        record.forceForPlugin = true;
      }
      records.push(record);
    } catch {}
  }
  return records;
}

/**
 * Custom styles by precedence, lowest first: a plugin ships one, the reader
 * overrides it, the project overrides that, and managed policy overrides all of
 * them — an administrator's style is not one a checkout gets to replace.
 */
function customOutputStyles(cwd: string): Map<string, OutputStyleRecord> {
  const byName = new Map<string, OutputStyleRecord>();
  const tiers = [
    pluginOutputStyleDirs().flatMap(({ plugin, dir }) =>
      readStylesDir(dir, "plugin", pluginStyleName(plugin, "")),
    ),
    readStylesDir(join(configRoot(), "output-styles"), "user"),
    readStylesDir(join(cwd, PROJECT_STYLES_DIR, "output-styles"), "project"),
    readStylesDir(join(systemPolicyDir(), "output-styles"), "policy"),
  ];
  for (const tier of tiers) for (const record of tier) byName.set(record.name, record);
  return byName;
}

/**
 * Resolve the active style: built-ins shadowed by customs, an unset setting
 * falling back to the default style. An unknown name resolves to null, which
 * leaves the system prompt without a style section.
 *
 * A plugin that insists on its style takes the answer before the setting is
 * read — its prompt only works under the voice it ships.
 */
export function resolveOutputStyle(
  styleName: string | undefined,
  cwd: string,
): OutputStyleRecord | null {
  const custom = customOutputStyles(cwd);
  const forced = forcedPluginStyle(custom.values());
  if (forced !== undefined) return forced;
  const name = styleName?.trim() || DEFAULT_OUTPUT_STYLE;
  return custom.get(name) ?? BUILT_IN_OUTPUT_STYLES[name] ?? null;
}

export interface OutputStyleOption {
  value: string;
  label: string;
  description: string;
}

/** Roster for the picker and wire listings: built-ins first, then customs. */
export function listOutputStyles(cwd: string): OutputStyleOption[] {
  const options: OutputStyleOption[] = [];
  const seen = new Set<string>();
  for (const [value, record] of Object.entries(BUILT_IN_OUTPUT_STYLES)) {
    seen.add(value);
    options.push({ value, label: record.name, description: record.description });
  }
  for (const [name, record] of customOutputStyles(cwd)) {
    if (seen.has(name)) continue;
    options.push({ value: name, label: record.name, description: record.description });
  }
  return options;
}
