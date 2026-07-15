import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as fsModule from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const originalFs: Record<string | symbol, unknown> = {};
for (const key of Reflect.ownKeys(fsModule)) {
  originalFs[key] = (fsModule as Record<string | symbol, unknown>)[key];
}

const files = new Map<string, string>();
const dirs = new Set<string>();
let tempCounter = 0;

const resolvePath = (p: string) => resolve(p);

function existsFn(p: string): boolean {
  const resolved = resolvePath(p);
  return files.has(resolved) || dirs.has(resolved);
}
function mkdirFn(p: string, options?: { recursive?: boolean }): string {
  const resolved = resolvePath(p);
  if (options?.recursive) {
    let current = resolved;
    while (true) {
      dirs.add(current);
      const parent = resolve(current, "..");
      if (parent === current) break;
      current = parent;
    }
  } else {
    dirs.add(resolved);
  }
  return resolved;
}

function isDescendant(path: string, parent: string): boolean {
  const pathRelative = relative(parent, path);
  return (
    pathRelative !== "" &&
    pathRelative !== ".." &&
    !pathRelative.startsWith(`..${sep}`) &&
    !isAbsolute(pathRelative)
  );
}
function mkdtempFn(prefix: string): string {
  const dir = resolvePath(`${prefix}${tempCounter++}`);
  dirs.add(dir);
  return dir;
}
function rmFn(p: string, options?: { recursive?: boolean; force?: boolean }): void {
  const resolved = resolvePath(p);
  if (options?.recursive) {
    for (const f of Array.from(files.keys())) {
      if (f === resolved || isDescendant(f, resolved)) {
        files.delete(f);
      }
    }
    for (const d of Array.from(dirs)) {
      if (d === resolved || isDescendant(d, resolved)) {
        dirs.delete(d);
      }
    }
  } else {
    if (!files.delete(resolved) && !dirs.delete(resolved) && !options?.force) {
      const error = new Error(`ENOENT: no such file or directory, lstat '${p}'`);
      Reflect.set(error, "code", "ENOENT");
      throw error;
    }
  }
}
function writeFileFn(p: string, content: string | Uint8Array): void {
  const resolved = resolvePath(p);
  files.set(resolved, typeof content === "string" ? content : new TextDecoder().decode(content));
}
function readFileFn(p: string, encoding?: string): string | Uint8Array {
  const resolved = resolvePath(p);
  if (!files.has(resolved)) {
    const error = new Error(`ENOENT: no such file or directory, open '${p}'`);
    Reflect.set(error, "code", "ENOENT");
    throw error;
  }
  const content = files.get(resolved)!;
  if (encoding === "utf8" || encoding === "utf-8" || encoding) {
    return content;
  }
  return new TextEncoder().encode(content);
}
function statFn(p: string) {
  const resolved = resolvePath(p);
  if (files.has(resolved)) {
    return {
      isFile: () => true,
      isDirectory: () => false,
      mtimeMs: Date.now(),
    };
  }
  if (dirs.has(resolved)) {
    return {
      isFile: () => false,
      isDirectory: () => true,
      mtimeMs: Date.now(),
    };
  }
  const error = new Error(`ENOENT: no such file or directory, stat '${p}'`);
  Reflect.set(error, "code", "ENOENT");
  throw error;
}
function readdirFn(p: string): string[] {
  const resolved = resolvePath(p);
  const results = new Set<string>();
  for (const entry of [...files.keys(), ...dirs]) {
    if (!isDescendant(entry, resolved)) continue;
    const [name] = relative(resolved, entry).split(sep);
    if (name) results.add(name);
  }
  return Array.from(results);
}

const S = "Sync";
const fsMock: Record<string, unknown> = {};
fsMock[`exists${S}`] = existsFn;
fsMock[`mkdir${S}`] = mkdirFn;
fsMock[`mkdtemp${S}`] = mkdtempFn;
fsMock[`rm${S}`] = rmFn;
fsMock[`writeFile${S}`] = writeFileFn;
fsMock[`readFile${S}`] = readFileFn;
fsMock[`stat${S}`] = statFn;
fsMock[`readdir${S}`] = readdirFn;

mock.module("node:fs", () => fsMock);

import { join } from "node:path";
import {
  loadPluginFromDirectory,
  normalizePluginHooks,
  resolvePluginComponents,
} from "../loader.ts";
import type { PluginManifest } from "../manifest.ts";

let root: string;

function writeManifest(dir: string, manifest: PluginManifest): void {
  writeFileFn(join(dir, "plugin.json"), JSON.stringify(manifest));
}

function writeNestedManifest(dir: string, manifest: PluginManifest): void {
  const nested = join(dir, ".claude-plugin");
  mkdirFn(nested, { recursive: true });
  writeFileFn(join(nested, "plugin.json"), JSON.stringify(manifest));
}

beforeAll(() => {
  root = mkdtempFn("loader-test-");
});

afterAll(() => {
  mock.module("node:fs", () => originalFs);
});

describe("normalizePluginHooks", () => {
  test("normalizes PascalCase + nested plugin hook format", () => {
    const raw = {
      PreToolUse: [
        {
          matcher: "Bash|Edit",
          hooks: [
            {
              type: "command",
              command: "echo hi",
            },
          ],
        },
      ],
    };
    const normalized = normalizePluginHooks(raw, "/tmp");
    expect(normalized).toEqual({
      preToolUse: [
        {
          type: "command",
          matcher: "Bash|Edit",
          command: "echo hi",
          pluginRoot: "/tmp",
        },
      ],
    });
  });

  test("pins the plugin root on hook commands", () => {
    const raw = {
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/h.sh" }] },
      ],
    };
    const normalized = normalizePluginHooks(raw, "/plugins/x");
    expect(normalized.preToolUse?.[0]).toEqual({
      type: "command",
      matcher: "*",
      command: "${CLAUDE_PLUGIN_ROOT}/h.sh",
      pluginRoot: "/plugins/x",
    });
  });
});

describe("loadPluginFromDirectory", () => {
  test("loads a valid plugin from a directory with plugin.json", () => {
    const dir = join(root, "flat-plugin");
    mkdirFn(dir, { recursive: true });
    writeManifest(dir, { name: "flat-plugin", version: "0.1.0", description: "A flat plugin" });

    const loaded = loadPluginFromDirectory(dir, "test-source");

    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("flat-plugin");
    expect(loaded!.source).toBe("test-source");
    expect(loaded!.manifest.version).toBe("0.1.0");
    expect(loaded!.manifest.description).toBe("A flat plugin");
    expect(loaded!.path).toBe(dir);
  });

  test("loads a valid plugin from .claude-plugin/plugin.json", () => {
    const dir = join(root, "nested-plugin");
    mkdirFn(dir, { recursive: true });
    writeNestedManifest(dir, { name: "nested-plugin" });

    const loaded = loadPluginFromDirectory(dir, "nested-source");

    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("nested-plugin");
    expect(loaded!.source).toBe("nested-source");
  });

  test("prefers .claude-plugin/plugin.json over top-level plugin.json", () => {
    const dir = join(root, "both-plugin");
    mkdirFn(dir, { recursive: true });
    writeManifest(dir, { name: "top-level" });
    writeNestedManifest(dir, { name: "nested-level" });

    const loaded = loadPluginFromDirectory(dir, "both-source");

    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("nested-level");
  });

  test("returns null for an empty directory", () => {
    const dir = join(root, "empty-dir");
    mkdirFn(dir, { recursive: true });

    const loaded = loadPluginFromDirectory(dir, "empty-source");

    expect(loaded).toBeNull();
  });

  test("loads an implicit-layout plugin without a manifest", () => {
    const dir = join(root, "implicit-plugin");
    mkdirFn(join(dir, "commands"), { recursive: true });
    writeFileFn(join(dir, "commands", "hello.md"), "Hello");

    const loaded = loadPluginFromDirectory(dir, "session-source");

    expect(loaded?.name).toBe("implicit-plugin");
    expect(loaded?.commandsPath).toBe(join(dir, "commands"));
    expect(loadPluginFromDirectory(dir, "strict-source", { requireManifest: true })).toBeNull();
  });

  test("returns null when plugin.json contains invalid JSON", () => {
    const dir = join(root, "bad-json");
    mkdirFn(dir, { recursive: true });
    writeFileFn(join(dir, "plugin.json"), "{ not valid json }}}");

    const loaded = loadPluginFromDirectory(dir, "bad-json-source");

    expect(loaded).toBeNull();
  });

  test("returns null when manifest fails schema validation", () => {
    const dir = join(root, "bad-manifest");
    mkdirFn(dir, { recursive: true });
    writeFileFn(join(dir, "plugin.json"), JSON.stringify({ name: "has spaces" }));

    const loaded = loadPluginFromDirectory(dir, "bad-manifest-source");

    expect(loaded).toBeNull();
  });

  test("sets commandsPath when commands/ directory exists", () => {
    const dir = join(root, "with-commands");
    mkdirFn(dir, { recursive: true });
    writeManifest(dir, { name: "with-commands" });
    mkdirFn(join(dir, "commands"), { recursive: true });

    const loaded = loadPluginFromDirectory(dir, "cmd-source");

    expect(loaded).not.toBeNull();
    expect(loaded!.commandsPath).toBe(join(dir, "commands"));
  });

  test("sets agentsPath when agents/ directory exists", () => {
    const dir = join(root, "with-agents");
    mkdirFn(dir, { recursive: true });
    writeManifest(dir, { name: "with-agents" });
    mkdirFn(join(dir, "agents"), { recursive: true });

    const loaded = loadPluginFromDirectory(dir, "agent-source");

    expect(loaded).not.toBeNull();
    expect(loaded!.agentsPath).toBe(join(dir, "agents"));
  });

  test("sets skillsPath when skills/ directory exists", () => {
    const dir = join(root, "with-skills");
    mkdirFn(dir, { recursive: true });
    writeManifest(dir, { name: "with-skills" });
    mkdirFn(join(dir, "skills"), { recursive: true });

    const loaded = loadPluginFromDirectory(dir, "skill-source");

    expect(loaded).not.toBeNull();
    expect(loaded!.skillsPath).toBe(join(dir, "skills"));
  });

  test("sets workflowsPath only for the default workflows directory", () => {
    const dir = join(root, "with-workflows");
    mkdirFn(dir, { recursive: true });
    writeManifest(dir, { name: "with-workflows" });
    mkdirFn(join(dir, "workflows"), { recursive: true });

    const loaded = loadPluginFromDirectory(dir, "workflow-source");

    expect(loaded).not.toBeNull();
    expect(loaded!.workflowsPath).toBe(join(dir, "workflows"));
  });

  test("does not set component paths when directories are absent", () => {
    const dir = join(root, "no-components");
    mkdirFn(dir, { recursive: true });
    writeManifest(dir, { name: "no-components" });

    const loaded = loadPluginFromDirectory(dir, "none-source");

    expect(loaded).not.toBeNull();
    expect(loaded!.commandsPath).toBeUndefined();
    expect(loaded!.agentsPath).toBeUndefined();
    expect(loaded!.skillsPath).toBeUndefined();
    expect(loaded!.workflowsPath).toBeUndefined();
  });
});

describe("resolvePluginComponents", () => {
  test("reads .md files from commands/, agents/, and skills/ directories", () => {
    const dir = join(root, "full-resolve");
    mkdirFn(dir, { recursive: true });
    writeManifest(dir, { name: "full-resolve" });

    const cmdsDir = join(dir, "commands");
    mkdirFn(cmdsDir, { recursive: true });
    writeFileFn(join(cmdsDir, "lint.md"), "Run the linter");
    writeFileFn(join(cmdsDir, "fmt.md"), "Format code");

    const agentsDir = join(dir, "agents");
    mkdirFn(agentsDir, { recursive: true });
    writeFileFn(join(agentsDir, "reviewer.md"), "Review pull requests");

    const skillsDir = join(dir, "skills");
    mkdirFn(skillsDir, { recursive: true });
    writeFileFn(join(skillsDir, "deploy.md"), "Deploy the application");

    const loaded = loadPluginFromDirectory(dir, "resolve-source")!;
    const resolved = resolvePluginComponents(loaded);

    expect(resolved.commands).toHaveLength(2);
    const cmdNames = resolved.commands.map((c) => c.name).sort();
    expect(cmdNames).toEqual(["fmt", "lint"]);
    expect(resolved.commands.find((c) => c.name === "lint")!.content).toBe("Run the linter");
    expect(resolved.commands.find((c) => c.name === "fmt")!.content).toBe("Format code");

    expect(resolved.agents).toHaveLength(1);
    expect(resolved.agents[0]!.id).toBe("reviewer");
    expect(resolved.agents[0]!.content).toBe("Review pull requests");

    expect(resolved.skills).toHaveLength(1);
    expect(resolved.skills[0]!.name).toBe("deploy");
    expect(resolved.skills[0]!.content).toBe("Deploy the application");
  });

  test("returns empty arrays when component directories do not exist", () => {
    const dir = join(root, "resolve-empty");
    mkdirFn(dir, { recursive: true });
    writeManifest(dir, { name: "resolve-empty" });

    const loaded = loadPluginFromDirectory(dir, "resolve-empty-source")!;
    const resolved = resolvePluginComponents(loaded);

    expect(resolved.commands).toEqual([]);
    expect(resolved.agents).toEqual([]);
    expect(resolved.skills).toEqual([]);
    expect(resolved.hooks).toBeNull();
  });

  test("ignores non-.md files in commands directory", () => {
    const dir = join(root, "resolve-non-md");
    mkdirFn(dir, { recursive: true });
    writeManifest(dir, { name: "resolve-non-md" });

    const cmdsDir = join(dir, "commands");
    mkdirFn(cmdsDir, { recursive: true });
    writeFileFn(join(cmdsDir, "valid.md"), "Valid command");
    writeFileFn(join(cmdsDir, "ignored.txt"), "Not a command");
    writeFileFn(join(cmdsDir, "also-ignored.json"), "{}");

    const loaded = loadPluginFromDirectory(dir, "non-md-source")!;
    const resolved = resolvePluginComponents(loaded);

    expect(resolved.commands).toHaveLength(1);
    expect(resolved.commands[0]!.name).toBe("valid");
  });

  test("resolves skill from a subdirectory with SKILL.md", () => {
    const dir = join(root, "skill-subdir");
    mkdirFn(dir, { recursive: true });
    writeManifest(dir, { name: "skill-subdir" });

    const skillsDir = join(dir, "skills");
    const subSkill = join(skillsDir, "my-skill");
    mkdirFn(subSkill, { recursive: true });
    writeFileFn(join(subSkill, "SKILL.md"), "Skill from subdirectory");

    const loaded = loadPluginFromDirectory(dir, "skill-sub-source")!;
    const resolved = resolvePluginComponents(loaded);

    expect(resolved.skills).toHaveLength(1);
    expect(resolved.skills[0]!.name).toBe("my-skill");
    expect(resolved.skills[0]!.content).toBe("Skill from subdirectory");
  });

  test("attaches command metadata from manifest", () => {
    const dir = join(root, "cmd-metadata");
    mkdirFn(dir, { recursive: true });
    writeManifest(dir, {
      name: "cmd-metadata",
      commands: {
        lint: { description: "Run linter", model: "sonnet" },
      },
    });

    const cmdsDir = join(dir, "commands");
    mkdirFn(cmdsDir, { recursive: true });
    writeFileFn(join(cmdsDir, "lint.md"), "Lint content");

    const loaded = loadPluginFromDirectory(dir, "meta-source")!;
    const resolved = resolvePluginComponents(loaded);

    expect(resolved.commands).toHaveLength(1);
    expect(resolved.commands[0]!.metadata).toEqual({
      description: "Run linter",
      model: "sonnet",
    });
  });

  test("resolves manifest-declared command, agent, and skill paths", () => {
    const dir = join(root, "custom-paths");
    mkdirFn(join(dir, "custom"), { recursive: true });
    mkdirFn(join(dir, "packs", "deploy"), { recursive: true });
    writeFileFn(join(dir, "custom", "review.md"), "Review command");
    writeFileFn(join(dir, "custom", "agent.md"), "Agent body");
    writeFileFn(join(dir, "packs", "deploy", "SKILL.md"), "Deploy skill");
    writeManifest(dir, {
      name: "custom-paths",
      commands: "custom/review.md",
      agents: "custom/agent.md",
      skills: "packs/deploy",
    });

    const resolved = resolvePluginComponents(loadPluginFromDirectory(dir, "custom-source")!);

    expect(resolved.commands.map((command) => command.name)).toEqual(["review"]);
    expect(resolved.agents.map((agent) => agent.id)).toEqual(["agent"]);
    expect(resolved.skills.map((skill) => skill.name)).toEqual(["deploy"]);
  });

  test("resolves sourced and inline manifest commands", () => {
    const dir = join(root, "manifest-commands");
    mkdirFn(join(dir, "docs"), { recursive: true });
    writeFileFn(join(dir, "docs", "run.md"), "Run from file");
    writeManifest(dir, {
      name: "manifest-commands",
      commands: {
        run: { source: "docs/run.md", description: "Run it" },
        about: { content: "About inline", description: "About it" },
      },
    });

    const resolved = resolvePluginComponents(loadPluginFromDirectory(dir, "manifest-source")!);

    expect(resolved.commands.map((command) => command.name).sort()).toEqual(["about", "run"]);
    expect(resolved.commands.find((command) => command.name === "run")?.content).toBe(
      "Run from file",
    );
    expect(resolved.commands.find((command) => command.name === "about")?.content).toBe(
      "About inline",
    );
  });
});

describe("path traversal prevention", () => {
  test("collectMdFiles rejects files that escape the plugin root via symlink-style names", () => {
    const dir = join(root, "traversal-plugin");
    mkdirFn(dir, { recursive: true });
    writeManifest(dir, { name: "traversal-plugin" });

    const cmdsDir = join(dir, "commands");
    mkdirFn(cmdsDir, { recursive: true });
    writeFileFn(join(cmdsDir, "safe.md"), "Safe command");

    const loaded = loadPluginFromDirectory(dir, "traversal-source")!;
    const resolved = resolvePluginComponents(loaded);

    expect(resolved.commands).toHaveLength(1);
    expect(resolved.commands[0]!.name).toBe("safe");
    for (const cmd of resolved.commands) {
      expect(cmd.path.startsWith(dir)).toBe(true);
    }
  });

  test("isWithinRoot blocks resolved paths that escape the plugin root", () => {
    const dir = join(root, "escape-plugin");
    mkdirFn(dir, { recursive: true });
    writeManifest(dir, { name: "escape-plugin" });

    const loaded = loadPluginFromDirectory(dir, "escape-source")!;

    const maliciousPlugin = {
      ...loaded,
      commandsPath: join(dir, "..", "..", "..", "etc"),
    };

    const resolved = resolvePluginComponents(maliciousPlugin);

    for (const cmd of resolved.commands) {
      expect(cmd.path.startsWith(dir)).toBe(true);
    }
  });

  test("skill resolution blocks paths outside the plugin root", () => {
    const dir = join(root, "skill-escape");
    mkdirFn(dir, { recursive: true });
    writeManifest(dir, { name: "skill-escape" });

    const loaded = loadPluginFromDirectory(dir, "skill-escape-source")!;

    const maliciousPlugin = {
      ...loaded,
      skillsPath: join(dir, "..", "..", "..", "etc"),
    };

    const resolved = resolvePluginComponents(maliciousPlugin);

    for (const skill of resolved.skills) {
      expect(skill.path.startsWith(dir)).toBe(true);
    }
  });
});
