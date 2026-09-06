import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@/engine/agents/frontmatter.ts";
import { register, type Skill } from "./registry.ts";

export function loadSkillFromMarkdown(
  name: string,
  src: string,
  builtin = false,
  source?: Skill["source"],
  skillRoot?: string,
): Skill {
  const parsed = parseFrontmatter(src);
  const aliasesRaw = parsed.fields.aliases ?? "";
  const aliases = parseListField(aliasesRaw);
  const ctx = parsed.fields.context === "fork" ? "fork" : "inline";
  const userInvocable = parsed.fields.userInvocable !== "false";
  const modelInvocableField = parsed.fields.modelInvocable;
  const modelInvocable =
    modelInvocableField === undefined ? ctx !== "fork" : modelInvocableField !== "false";
  const argumentHint = parsed.fields.argumentHint?.trim() || null;
  const skill: Skill = {
    name: parsed.fields.name ?? name,
    aliases,
    description: parsed.fields.description ?? "",
    whenToUse: parsed.fields.whenToUse ?? "",
    argumentHint,
    userInvocable,
    modelInvocable,
    context: ctx,
    body: parsed.body,
    builtin,
    source: source ?? (builtin ? "builtin" : "user"),
    ...(skillRoot ? { skillRoot } : {}),
    authorModelLock: modelInvocableField === "false",
  };
  return skill;
}

function parseListField(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter((s) => s.length > 0);
  }
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadAndRegister(
  name: string,
  src: string,
  builtin = false,
  source?: Skill["source"],
  skillRoot?: string,
): Skill {
  const s = loadSkillFromMarkdown(name, src, builtin, source, skillRoot);
  register(s);
  return s;
}

export interface LoaderFS {
  readdirSync: (path: string) => string[];
  statSync: (path: string) => { isFile: () => boolean; isDirectory: () => boolean };
  readFileSync: (path: string, encoding: "utf8") => string;
}

const defaultFS: LoaderFS = {
  readdirSync,
  statSync,
  readFileSync,
};

export function loadProjectCommandsFromDirectory(dir: string, fs: LoaderFS = defaultFS): number {
  // Project slash commands (`.otherside/commands/*.md`) are USER-invocable only —
  // they surface as slash commands via dispatch but are forced modelInvocable:false
  // so they are never advertised to the model in the skill listing (assemble.ts).
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    try {
      if (!fs.statSync(path).isFile()) continue;
      const content = fs.readFileSync(path, "utf8");
      const name = entry.replace(/\.md$/, "");
      const skill = loadSkillFromMarkdown(name, content, false, "project", path);
      register({ ...skill, userInvocable: true, modelInvocable: false });
      count += 1;
    } catch {}
  }
  return count;
}

export function readSkillsFromDir(dir: string, source: "user" | "project" = "user"): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    const path = join(dir, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const skillFile = join(path, "SKILL.md");
      try {
        const content = readFileSync(skillFile, "utf8");
        loadAndRegister(entry, content, false, source, path);
        count += 1;
      } catch {}
      continue;
    }
    if (stat.isFile() && entry.endsWith(".md")) {
      const name = entry.replace(/\.md$/, "");
      try {
        const content = readFileSync(path, "utf8");
        loadAndRegister(name, content, false, source, path);
        count += 1;
      } catch {}
    }
  }
  return count;
}
