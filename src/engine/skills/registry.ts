import { createRegistry } from "@/kernel/std/state/registry.ts";

export interface Skill {
  name: string;
  aliases: string[];
  description: string;
  whenToUse: string;
  argumentHint: string | null;
  userInvocable: boolean;
  modelInvocable: boolean;
  context: "inline" | "fork";
  body: string;
  builtin: boolean;
}

const registry = createRegistry<Skill>({
  keyOf: (s) => s.name,
  supportsAlias: "inline",
  aliasOf: (s) => s.aliases,
});

export type SkillRegistrySnapshot = readonly Skill[];

export function register(skill: Skill): void {
  registry.register(skill);
}

export function get(name: string): Skill | undefined {
  return registry.get(name);
}

export function list(): Skill[] {
  return registry.list().sort((a, b) => a.name.localeCompare(b.name));
}

export function snapshot(): SkillRegistrySnapshot {
  return registry.list();
}

export function replaceSnapshot(next: SkillRegistrySnapshot): void {
  registry.clear();
  for (const skill of next) registry.register(skill);
}

export function clear(): void {
  registry.clear();
}

export function lookupInvocableBody(name: string): string | null {
  if (name.length === 0 || name.includes("/") || name.includes("..")) return null;
  const skill = registry.get(name);
  if (!skill || skill.name !== name) return null;
  return skill.body;
}

export function availableNames(): string[] {
  return registry
    .list()
    .map((s) => s.name)
    .sort();
}
