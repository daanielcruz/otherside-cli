import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadedPlugin } from "@/engine/plugins/loader.ts";
import * as plugins from "@/engine/plugins/registry.ts";
import type { Skill } from "@/engine/skills/registry.ts";
import * as skills from "@/engine/skills/registry.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import { dispatch } from "../dispatch.ts";
import { expandCommand } from "../expansion.ts";
import type { SlashContext } from "../types.ts";

let workspace = "";
let pluginRoot = "";

function skillNamed(name: string, body: string, over: Partial<Skill> = {}): Skill {
  return {
    name,
    aliases: [],
    description: "probe",
    whenToUse: "",
    argumentHint: null,
    userInvocable: true,
    modelInvocable: false,
    context: "inline",
    body,
    builtin: false,
    source: "project",
    authorModelLock: false,
    ...over,
  };
}

function ctxWith(config?: UserConfig): SlashContext {
  return {
    config,
    session: { id: "session-probe", cwd: workspace },
  } as unknown as SlashContext;
}

/** A hook that leaves one line per firing, so double-firing is countable. */
function tallyingConfig(tally: string): UserConfig {
  return {
    hooks: { userPromptExpansion: [{ matcher: "*", command: `printf 'fired\\n' >> ${tally}` }] },
  } as UserConfig;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "expansion-"));
  pluginRoot = join(workspace, "probe-plugin");
  mkdirSync(join(pluginRoot, "commands"), { recursive: true });
  skills.clear();
  plugins.clear();
});

afterEach(() => {
  skills.clear();
  plugins.clear();
  rmSync(workspace, { recursive: true, force: true });
});

describe("what a command that stands in for words resolves to", () => {
  test("a skill keeps its kind, and no turn is resolved on its behalf here", async () => {
    skills.register(skillNamed("probe-skill", "Do the thing with: $ARGUMENTS"));

    const result = await dispatch("/probe-skill two words", ctxWith());

    // The skill runner reads the frontmatter and decides between a turn and a
    // fork; a prompt resolved here would take that choice away from it.
    expect(result.kind).toBe("skill");
    expect(result.shouldQuery).toBeUndefined();
    expect(result.queryText).toBeUndefined();
  });

  test("no arguments leaves the placeholder standing for nothing rather than for itself", () => {
    skills.register(skillNamed("bare", "Plan: $ARGUMENTS."));

    expect(expandCommand("bare", "")?.prompt).toBe("Plan: .");
  });

  test("every occurrence of the placeholder is filled, not just the first", () => {
    skills.register(skillNamed("twice", "$ARGUMENTS then $ARGUMENTS"));

    expect(expandCommand("twice", "go")?.prompt).toBe("go then go");
  });

  test("a plugin command resolves too, with its metadata block left behind", () => {
    writeFileSync(
      join(pluginRoot, "commands", "ship.md"),
      "---\ndescription: Ship it\n---\nShip the branch named $ARGUMENTS.\n",
    );
    const plugin: LoadedPlugin = {
      name: "probe-plugin",
      path: pluginRoot,
      source: "test",
      commandsPath: join(pluginRoot, "commands"),
      manifest: { name: "probe-plugin" },
    } as LoadedPlugin;
    const pluginId = plugins.register(plugin);

    const expansion = expandCommand(`${pluginId}:ship`, "release");

    expect(expansion?.source).toBe("plugin");
    expect(expansion?.prompt.trim()).toBe("Ship the branch named release.");
    expect(expansion?.prompt).not.toContain("description:");
  });

  test("a name nothing answers to resolves to nothing", () => {
    expect(expandCommand("not-a-skill", "")).toBeNull();
  });
});

describe("what the reader gets back", () => {
  test("a command the catalog names but nothing defines says so instead of going quiet", async () => {
    // The catalog names /ultraplan outright rather than deriving it from the
    // registry, so the command survives a definition that failed to load. A
    // cleared draft and no reason for it is the one outcome to refuse.
    const result = await dispatch("/ultraplan something", ctxWith());

    expect(result.kind).toBe("unknown");
    expect(result.feedback).toContain("could not be resolved");
    expect(result.queryText).toBeUndefined();
    expect(result.shouldQuery).toBeUndefined();
  });

  test("a workflow command survives the same way a skill does", async () => {
    skills.register(skillNamed("ultraplan", "Plan this: $ARGUMENTS", { builtin: true }));

    const result = await dispatch("/ultraplan the migration", ctxWith());

    expect(result.kind).toBe("workflow");
    expect(result.command?.name).toBe("ultraplan");
  });

  test("the expansion is announced to the watching hook exactly once", async () => {
    const tally = join(workspace, "tally.txt");
    skills.register(skillNamed("watched", "words: $ARGUMENTS"));

    await dispatch("/watched here", ctxWith(tallyingConfig(tally)));

    const fired = existsSync(tally) ? readFileSync(tally, "utf8").trim().split("\n") : [];
    expect(fired).toEqual(["fired"]);
  });

  test("a skill that runs as a fork announces itself once too, on the same path", async () => {
    // Both shapes are announced here and nowhere else, so neither the fork nor
    // the inline run can double-fire or go unannounced.
    const tally = join(workspace, "fork-tally.txt");
    skills.register(skillNamed("watched-fork", "words: $ARGUMENTS", { context: "fork" }));

    await dispatch("/watched-fork here", ctxWith(tallyingConfig(tally)));

    const fired = existsSync(tally) ? readFileSync(tally, "utf8").trim().split("\n") : [];
    expect(fired).toEqual(["fired"]);
  });

  test("a plugin command announces itself once as well", async () => {
    const tally = join(workspace, "plugin-tally.txt");
    writeFileSync(
      join(pluginRoot, "commands", "ship.md"),
      "---\ndescription: Ship it\n---\nShip the branch named $ARGUMENTS.\n",
    );
    const plugin: LoadedPlugin = {
      name: "probe-plugin",
      path: pluginRoot,
      source: "test",
      commandsPath: join(pluginRoot, "commands"),
      manifest: { name: "probe-plugin" },
    } as LoadedPlugin;
    const pluginId = plugins.register(plugin);

    await dispatch(`/${pluginId}:ship release`, ctxWith(tallyingConfig(tally)));

    const fired = existsSync(tally) ? readFileSync(tally, "utf8").trim().split("\n") : [];
    expect(fired).toEqual(["fired"]);
  });
});
